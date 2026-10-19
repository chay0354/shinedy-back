import { isDbEnabled } from './supabase.js';
import { loadMembershipTerms, saveMembershipTerms } from './membershipTerms.js';
import { attachCourierJob, planRequiresDeliverySignature, resolveCourierJob } from './courierJob.js';
import { hasIdDocument, maskNationalId } from './idVault.js';

function maskNationalIdForClient(value) {
  return maskNationalId(value);
}

const STATUSES = ['זמין', 'שמור', 'אצל לקוחה', 'בניקוי', 'בתיקון', 'בדרך ללקוחה', 'בדרך חזרה', 'נמכר'];
const STAGES = ['ליקוט', 'בקרה', 'אריזה', 'נשלח'];
const STAGE_ALIASES = {
  חדשה: 'ליקוט',
  בליקוט: 'ליקוט',
  ליקוט: 'ליקוט',
  בקרה: 'בקרה',
  נארזה: 'אריזה',
  אריזה: 'אריזה',
  נשלח: 'נשלח',
  נשלחה: 'נשלח',
};

function normalizeFulfillmentStatus(status) {
  return STAGE_ALIASES[String(status || '').trim()] || String(status || '').trim();
}

function orderOwnsUnit(order, unitId) {
  return (order?.items || []).some((it) => {
    if (it === unitId) return true;
    if (it && typeof it === 'object') return it.id === unitId || it.serial === unitId;
    return false;
  });
}
const CREDIT_PCT = 10;
const DAY_MS = 86400000;
const EXTRA_SHIP_FEE = 65;
const SHIP_FREE_WINDOW_MS = 60 * DAY_MS;
const BILLING_PERIOD_MS = 30 * DAY_MS;
const SHIPMENT_TYPES = new Set(['הזמנה', 'הזמנה ראשונה', 'החלפה', 'החזרה']);
const DELIVERED_STATUSES = new Set(['נשלח', 'נשלחה', 'נמסרה']);
const BOX_ORDER_TYPES = new Set(['הזמנה', 'הזמנה ראשונה', 'החלפה']);
// Ledger keys live inside profile.address; never let a client payload overwrite them.
const ADDRESS_LEDGER_KEYS = ['charges', 'shippingCharges', 'pauses', 'billingStart', 'canceledAt', 'lastPlanId'];

export function clientAddress(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const next = { ...raw };
  for (const key of ADDRESS_LEDGER_KEYS) delete next[key];
  return next;
}

const STATUS_STYLE = {
  זמין: { bg: '#EDF3EA', fg: '#3E5C3F' },
  שמור: { bg: '#EFEBE4', fg: '#6B6157' },
  'אצל לקוחה': { bg: '#F6EEDD', fg: '#8A6A2A' },
  בניקוי: { bg: '#EAF0F2', fg: '#3E6470' },
  בתיקון: { bg: '#F7E9E4', fg: '#8C4A34' },
  'בדרך ללקוחה': { bg: '#FBF6EC', fg: '#A9812F' },
  'בדרך חזרה': { bg: '#F3EAF0', fg: '#7A4A68' },
  נמכר: { bg: '#EDE8E1', fg: '#5C5348' },
};

const PLAN_ALIASES = {
  silver: 'essentials',
  combined: 'signature',
  gold: 'prestige',
  essentials: 'silver',
  signature: 'combined',
  prestige: 'gold',
};

export function normalizePayment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const last4 = String(raw.last4 || '').replace(/\D/g, '').slice(-4);
  if (last4.length < 4) return null;
  return {
    holder: String(raw.holder || '').trim(),
    last4,
    expiry: String(raw.expiry || '').trim(),
  };
}

function expiryIsValid(expiry, now = new Date()) {
  const m = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(String(expiry || '').trim());
  if (!m) return false;
  const month = Number(m[1]);
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (month < 1 || month > 12) return false;
  return new Date(year, month, 1) > now;
}

/** A card the server can charge: a gateway token in DB mode, any valid card in demo mode. */
function paymentIsUsable(raw, now = new Date()) {
  const payment = normalizePayment(raw);
  if (!payment || !expiryIsValid(payment.expiry, now)) return false;
  return !isDbEnabled || Boolean(raw.token && raw.tokef);
}

function paymentError(message) {
  const err = new Error(message);
  err.status = 402;
  return err;
}

/** What the browser may see of the saved card. */
function paymentView(raw) {
  const payment = normalizePayment(raw);
  if (!payment) return null;
  return { ...payment, onFile: paymentIsUsable(raw) };
}

export function savedCard() {
  return paymentIsUsable(state.payment) ? state.payment : null;
}

/** Stores the card returned by the payment gateway (token + expiry), replacing the old one. */
export function setCardFromGateway({ token, tokef, last4, holder, holderId }) {
  const yymm = String(tokef || '').padStart(4, '0');
  state.payment = {
    holder: String(holder || state.registration?.fullName || state.currentUserName || '').trim(),
    last4: String(last4 || token || '').replace(/\D/g, '').slice(-4),
    expiry: `${yymm.slice(2, 4)}/${yymm.slice(0, 2)}`,
    token: String(token || ''),
    tokef: yymm,
    holderId: /^\d{9}$/.test(String(holderId || '')) ? String(holderId) : '',
  };
  if (!state.registration) state.registration = {};
  state.registration.paymentMethodAdded = true;
  retryFailedCharges();
}

/** Name and contact details sent to the gateway with a charge. */
export function billingContact() {
  const full = String(state.registration?.fullName || state.currentUserName || '').trim();
  const [firstName, ...rest] = full.split(/\s+/);
  return {
    firstName: firstName || '',
    lastName: rest.join(' '),
    email: state.registration?.email || '',
    cell: state.registration?.phone || '',
    street: [state.address?.street, state.address?.houseNo].filter(Boolean).join(' '),
    city: state.address?.city || '',
    idNumber: /^\d{9}$/.test(String(state.registration?.nationalId || ''))
      ? state.registration.nationalId
      : '',
  };
}

function resolvePlan(planId) {
  if (!planId) return null;
  return (
    state.plans.find((p) => p.id === planId) ||
    state.plans.find((p) => p.id === PLAN_ALIASES[planId]) ||
    null
  );
}

function makeInitialState() {
  const unitMap = {
    RCV1702: 'זמין',
    RCV1023: 'זמין',
    RCV1071: 'זמין',
    RCV1208: 'זמין',
    RCV2488: 'זמין',
    RCV1189: 'זמין',
    RCV1219: 'זמין',
  };

  return {
    subscribed: false,
    planId: null,
    pointsBalance: 0,
    credits: 0,
    creditsUsed: 0,
    subscribedAt: null,
    address: {},
    payment: null,
    purchases: [],
    purchaseCounter: 0,
    cart: [],
    exchangeReturns: [],
    exchangeCart: [],
    myItems: [],
    flash: null,
    orderCounter: 1043,
    membershipTerms: loadMembershipTerms(),
    plans: [
      { id: 'silver', name: 'מסלול כסף', price: 199, points: 100, maxItems: 2, exchanges: 99, shipping: true, tagline: 'כסף וכסף מצופה זהב · אבני מויסנייט' },
      { id: 'combined', name: 'מסלול משולב', price: 299, points: 170, maxItems: 4, exchanges: 99, shipping: true, tagline: 'כסף וזהב · יהלומי מעבדה קטנים' },
      { id: 'gold', name: 'מסלול זהב', price: 499, points: 280, maxItems: 6, exchanges: 99, shipping: true, tagline: 'זהב · יהלומי מעבדה גדולים' },
      { id: 'essentials', name: 'Essentials', price: 249, points: 400, maxItems: 2, exchanges: 1, shipping: false, tagline: 'להתחיל להתנסות' },
      { id: 'signature', name: 'Signature', price: 449, points: 800, maxItems: 4, exchanges: 2, shipping: true, tagline: 'הבחירה הפופולרית' },
      { id: 'prestige', name: 'Prestige', price: 749, points: 1400, maxItems: 6, exchanges: 4, shipping: true, tagline: 'לגרדרובה עשירה' },
    ],
    products: [
      { id: 'RCV1702', sku: 'RCV1702', name: 'שיינא', category: 'טבעות', metal: 'זהב 14K', stone: 'יהלום מעבדה 0.92 קראט', points: 110, price: 7490, image: '/catalog/RCV1702.jpg' },
      { id: 'RCV1023', sku: 'RCV1023', name: 'טבעת אובלית', category: 'טבעות', metal: 'זהב 14K', stone: 'יהלום מעבדה 2.76 קראט', points: 260, price: 21900, image: '/catalog/RCV1023.jpg' },
      { id: 'RCV1071', sku: 'RCV1071', name: 'טבעת חישוק', category: 'טבעות', metal: 'זהב 14K', stone: 'יהלום מעבדה 0.47 קראט', points: 70, price: 3490, image: '/catalog/RCV1071.jpg' },
      { id: 'RCV1208', sku: 'RCV1208', name: 'טבעת משולבת', category: 'טבעות', metal: 'זהב 14K', stone: 'יהלום מעבדה 1.23 קראט', points: 150, price: 9900, image: '/catalog/RCV1208.jpg' },
      { id: 'RCV2488', sku: 'RCV2488', name: 'טבעת שתי אבנים', category: 'טבעות', metal: 'זהב צהוב', stone: 'יהלום מעבדה 1.01 קראט', points: 130, price: 8900, image: '/catalog/RCV2488.jpg' },
      { id: 'RCV1189', sku: 'RCV1189', name: 'טבעת שורה', category: 'טבעות', metal: 'זהב 14K', stone: 'יהלום מעבדה 1.59 קראט', points: 190, price: 12900, image: '/catalog/RCV1189.jpg' },
      { id: 'RCV1219', sku: 'RCV1219', name: 'טבעת ספירלה', category: 'טבעות', metal: 'זהב 14K', stone: 'יהלום מעבדה 0.67 קראט', points: 90, price: 5990, image: '/catalog/RCV1219.jpg' },
    ],
    units: Object.entries(unitMap).map(([id, status]) => ({
      id,
      modelId: id.split('-')[0],
      status,
      demoOnly: false,
    })),
    orders: [
      { id: 'ORD-1041', type: 'הזמנה ראשונה', customerName: 'נועה כהן', items: ['N08-3'], returnItems: [], status: 'אריזה', date: 'לפני 2 ימים', courierJob: 'delivery' },
    ],
    // Return pouches: QR → scan → confirm contents → QC → cleaning/repair
    returnPouches: [
      {
        id: 'POUCH-9001',
        qr: 'QR-9001',
        orderId: 'ORD-SEED',
        customerName: 'נועה כהן',
        returnItems: ['B33-3'],
        newItems: [],
        status: 'in_transit', // in_transit | scanned | contents_ok | completed
        scanned: false,
        createdAt: 'לפני יום',
        demoCustomer: false,
        pendingPoints: 200,
        pointsCredited: false,
        inventoryCleared: false,
      },
    ],
    pouchCounter: 9002,
    lastPouchId: null,
    shippingCharges: [],
    // Manager fixtures only — not the interactive demo customer
    staffCustomers: [],
    seedCustomers: [
      { id: 'seed-0', name: 'נועה כהן', plan: 'Signature', points: '520/800', status: 'פעיל', phone: '050-1111111', email: 'noa@example.com' },
      { id: 'seed-1', name: 'תמר לוי', plan: 'Prestige', points: '1100/1400', status: 'פעיל', phone: '052-2222222', email: 'tamar@example.com' },
      { id: 'seed-2', name: 'שני אברהם', plan: 'Essentials', points: '0/400', status: 'מוקפא', phone: '054-3333333', email: 'shani@example.com' },
    ],
  };
}

function decoratePouch(pouch) {
  const items = (pouch.returnItems || []).map((uid) => {
    const u = unit(uid);
    const p = u ? product(u.modelId) : null;
    const st = u ? STATUS_STYLE[u.status] || { bg: '#EEE', fg: '#555' } : { bg: '#EEE', fg: '#555' };
    return {
      unitId: uid,
      name: p?.name || uid,
      category: p?.category || '',
      modelId: u?.modelId || '',
      status: u?.status || '—',
      badgeBg: st.bg,
      badgeFg: st.fg,
      points: p?.points || 0,
    };
  });
  const statusLabels = {
    in_transit: 'בתהליך החזרה — ממתין לסריקה במחסן',
    scanned: 'נסרק — ממתין לאישור תכולה',
    contents_ok: 'תכולה אושרה — בבקרת איכות',
    completed: 'הושלם',
  };
  const pendingPoints =
    typeof pouch.pendingPoints === 'number'
      ? pouch.pendingPoints
      : items.reduce((sum, i) => sum + (i.points || 0), 0);
  return {
    ...pouch,
    items,
    itemsLabel: items.map((i) => i.name).join(', '),
    itemCount: items.length,
    statusLabel: statusLabels[pouch.status] || pouch.status,
    pendingPoints,
    pendingQc: items.filter((i) => i.status === 'בדרך חזרה'),
    canCancel:
      (pouch.userId === state.currentUserId || pouch.demoCustomer) &&
      pouch.status === 'in_transit' &&
      !pouch.endReason,
  };
}

/** Dedicated units for the demo customer only — never shared with manager seed stock. */
const DEMO_OWNED_UNITS = [
  { id: 'R34-D1', modelId: 'R34' },
  { id: 'E08-D1', modelId: 'E08' },
  { id: 'B12-D1', modelId: 'B12' },
];

let state = makeInitialState();

export function getMutableState() {
  return state;
}

export function mergeOrders(orders) {
  const unique = [...new Map(orders.map((o) => [o.id, o])).values()];
  state.orders = unique;
  rebuildPurchasesFromOrders();
}

export function mergePouches(pouches) {
  const unique = [...new Map(pouches.map((p) => [p.id, p])).values()];
  state.returnPouches = unique;
}

export function clearUserSession() {
  state.currentUserId = null;
  state.currentUserRole = 'customer';
  state.currentUserName = null;
  state.subscribed = false;
  state.planId = null;
  state.pointsBalance = 0;
  state.cart = [];
  state.exchangeReturns = [];
  state.exchangeCart = [];
  state.myItems = [];
  state.flash = null;
  state.lastPouchId = null;
  state.registration = null;
  state.creditsUsed = 0;
  state.subscribedAt = null;
  state.address = {};
  state.payment = null;
  state.shippingCharges = [];
  state.deletedOrderIds = [];
  state.deletedPouchIds = [];
  state.units = state.units.filter((u) => !u.demoOnly && !u.ownerUserId);
}

function isMyOrder(o) {
  if (state.currentUserId) return o.userId === state.currentUserId;
  return o.customerName === 'הלקוחה (דמו)';
}

function isMyPouch(p) {
  if (state.currentUserId) return p.userId === state.currentUserId;
  return p.demoCustomer;
}

function product(id) {
  return state.products.find((p) => p.id === id);
}

function unit(id) {
  return state.units.find((u) => u.id === id);
}

function availableUnitsForProduct(id) {
  return state.units.filter((u) => u.modelId === id && u.status === 'זמין');
}

function cartPoints() {
  return state.cart.reduce((sum, id) => sum + (product(id)?.points || 0), 0);
}

/** Points locked in jewelry the customer still holds or is returning (not yet credited). */
function pointsTiedUpInJewelry() {
  let sum = 0;
  const seen = new Set();
  for (const uid of state.myItems) {
    if (seen.has(uid)) continue;
    const u = unit(uid);
    if (!u) continue;
    if (state.exchangeReturns.includes(uid)) continue;
    if (u.status === 'אצל לקוחה' || u.status === 'בדרך ללקוחה' || u.status === 'בדרך חזרה') {
      seen.add(uid);
      sum += product(u.modelId)?.points || 0;
    }
  }
  return sum;
}

function remainingPoints() {
  const cart = cartPoints();
  const tied = pointsTiedUpInJewelry();
  const planCap = state.planId ? currentPlan().points : 0;
  return planCap - tied - cart;
}

function exchangeFreedPoints() {
  return state.exchangeReturns.reduce((sum, uid) => {
    const u = unit(uid);
    const p = u ? product(u.modelId) : null;
    return sum + (p?.points || 0);
  }, 0);
}

function exchangeCartPoints() {
  return state.exchangeCart.reduce((sum, id) => {
    const p = product(id);
    return sum + (p?.points || 0);
  }, 0);
}

function exchangeAvailablePoints() {
  return state.pointsBalance + exchangeFreedPoints() - exchangeCartPoints();
}

/** Drop return selections that no longer exist on the demo customer. */
function pruneExchangeReturns() {
  state.exchangeReturns = state.exchangeReturns.filter((uid) => {
    const u = unit(uid);
    return Boolean(u) && state.myItems.includes(uid) && u.status === 'אצל לקוחה';
  });
}

/** Drop inventory rows whose units were removed (e.g. after logout/reset). */
function pruneMyItems() {
  state.myItems = state.myItems.filter((uid) => Boolean(unit(uid)));
}

/** Align unit status with order lifecycle; fix legacy rows from the old skip-warehouse bug. */
function reconcileCustomerUnits() {
  if (!state.currentUserId) return;

  for (const uid of state.myItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx < 0) continue;
    const u = state.units[idx];
    const purchaseOrder = state.orders.find(
      (o) =>
        o.userId === state.currentUserId &&
        BOX_ORDER_TYPES.has(o.type || 'הזמנה') &&
        (o.items || []).includes(uid),
    );
    const delivered = DELIVERED_STATUSES.has(purchaseOrder?.status);
    const inReturnFlow = u.status === 'בדרך חזרה' || u.status === 'בניקוי' || u.status === 'בתיקון';

    if (inReturnFlow) {
      if (!u.ownerUserId) {
        state.units[idx] = { ...u, ownerUserId: state.currentUserId };
      }
      continue;
    }

    if (delivered && (u.status === 'בדרך ללקוחה' || u.status === 'זמין')) {
      state.units[idx] = {
        ...u,
        status: 'אצל לקוחה',
        ownerUserId: state.currentUserId,
      };
      continue;
    }

    if (u.status === 'זמין' || (u.status === 'אצל לקוחה' && purchaseOrder && !delivered)) {
      state.units[idx] = {
        ...u,
        status: delivered ? 'אצל לקוחה' : 'בדרך ללקוחה',
        ownerUserId: state.currentUserId,
      };
      continue;
    }

    if (!u.ownerUserId) {
      state.units[idx] = { ...u, ownerUserId: state.currentUserId };
    }
  }

  // Active return pouches: keep units in transit and on the customer's inventory list.
  for (const pouch of state.returnPouches) {
    if (!isMyPouch(pouch) || pouch.inventoryCleared || pouch.status === 'completed') continue;
    for (const uid of pouch.returnItems || []) {
      const idx = state.units.findIndex((u) => u.id === uid);
      if (idx < 0) continue;
      const u = state.units[idx];
      if (u.status !== 'בדרך חזרה' && u.status !== 'בניקוי' && u.status !== 'בתיקון') {
        state.units[idx] = {
          ...u,
          status: 'בדרך חזרה',
          ownerUserId: state.currentUserId,
        };
      }
      if (!state.myItems.includes(uid)) {
        state.myItems.push(uid);
      }
    }
    if (!state.lastPouchId) {
      state.lastPouchId = pouch.id;
    }
  }
}

// Stock levels are internal: customers see availability, never unit counts.
function isStaffViewer() {
  return state.currentUserRole === 'admin' || state.currentUserRole === 'warehouse';
}

function decorateProduct(p, budget, cartArr) {
  const avail = availableUnitsForProduct(p.id).length;
  const inCart = cartArr.includes(p.id);
  const disabled = !inCart && (avail === 0 || budget < p.points);
  return {
    ...p,
    inStock: avail > 0,
    availLabel: avail > 0 ? 'זמין' : 'אין במלאי',
    ...(isStaffViewer() ? { availCount: avail } : {}),
    inCart,
    addDisabled: disabled,
    buttonLabel: inCart ? 'בסל ✓' : disabled ? 'לא ניתן' : 'הוסיפי לסל',
  };
}

function decorateOrder(o) {
  const courierJob = resolveCourierJob(o);
  return attachCourierJob(
    {
      ...o,
      itemsLabel: (o.items || [])
        .map((uid) => {
          const u = unit(uid);
          return u ? product(u.modelId)?.name || uid : uid;
        })
        .join(', '),
    },
    courierJob,
    courierOpts(o.planId),
  );
}

const CUSTOMER_ORDER_STATUS = {
  ליקוט: 'בדרך',
  בקרה: 'בדרך',
  אריזה: 'בדרך',
  נשלח: 'נמסרה',
  'בדרך חזרה': 'בתהליך החזרה',
};

function customerUnitStatusLabel(status) {
  const labels = {
    'אצל לקוחה': 'הפריט אצלי',
    'בדרך ללקוחה': 'בדרך',
    'בדרך חזרה': 'בתהליך החזרה',
  };
  return labels[status] || status;
}

function trackingFor(o) {
  if (!['נשלח', 'נשלחה', 'נמסרה'].includes(o.status)) return null;
  return o.tracking || `SHN-TRK-${String(o.id).replace(/\W/g, '').slice(-8).toUpperCase()}`;
}

function creditMonthsOf(fromIso) {
  if (!fromIso) return 0;
  const from = new Date(fromIso).getTime();
  const to = Date.now();
  if (!Number.isFinite(from) || to <= from) return 0;
  return Math.floor((to - from) / (DAY_MS * 30));
}

function computedCreditBalance() {
  const plan = currentPlan();
  const months = creditMonthsOf(state.subscribedAt);
  const earned = months * (plan.price || 0) * (CREDIT_PCT / 100);
  if (state.subscribedAt) {
    return Math.max(0, earned - (state.creditsUsed || 0));
  }
  return Math.max(0, Number(state.credits) || 0);
}

function purchaseMetaFromOrder(o) {
  const meta = (o.newItems || []).find((x) => x && x.kind === 'purchase-meta') || {};
  const serial = Array.isArray(o.items) ? o.items[0] : o.items;
  return {
    id: o.id,
    userId: o.userId || null,
    buyer: meta.buyer || null,
    recipient: o.customerName,
    pid: meta.pid,
    serial,
    name: meta.name,
    sku: meta.sku,
    date: o.date,
    price: Number(meta.price) || 0,
    creditUsed: Number(meta.creditUsed) || 0,
    paid: Number(meta.paid) || 0,
    address: meta.address || {},
    payment: meta.payment || null,
    needsShipping: Boolean(meta.needsShipping) && !meta.shippedAt,
    shippedAt: meta.shippedAt || null,
  };
}

function rebuildPurchasesFromOrders() {
  state.purchases = state.orders.filter((o) => o.type === 'רכישה').map(purchaseMetaFromOrder);
}

function isSuspended() {
  return Boolean(state.registration?.suspended || state.registration?.suspendedAt);
}

function hasOpenReturn() {
  return state.returnPouches.some((p) => isMyPouch(p) && p.status !== 'completed');
}

function decorateCustomerOrder(o) {
  const base = decorateOrder(o);
  const outbound = ['הזמנה', 'הזמנה ראשונה', 'החלפה', 'רכישה'].includes(o.type || 'הזמנה');
  const isActive = outbound
    ? !['נשלח', 'נשלחה', 'נמסרה'].includes(o.status)
    : !['נשלח', 'נשלחה', 'הושלמה'].includes(o.status);
  const itemsDetail = (o.items || []).map((uid) => {
    const u = unit(uid);
    const p = u ? product(u.modelId) : null;
    const st = u ? STATUS_STYLE[u.status] || { bg: '#EEE', fg: '#555' } : { bg: '#EEE', fg: '#555' };
    return {
      unitId: uid,
      name: p?.name || uid,
      category: p?.category || '',
      status: u?.status || '—',
      statusLabel: customerUnitStatusLabel(u?.status),
      badgeBg: st.bg,
      badgeFg: st.fg,
    };
  });
  return {
    ...base,
    customerStatus: CUSTOMER_ORDER_STATUS[o.status] || o.status,
    isActive,
    itemsDetail,
    inTransitItems: itemsDetail.filter((i) => i.status === 'בדרך ללקוחה'),
    tracking: trackingFor(o),
    trackingStatus: o.status === 'נמסרה' ? 'נמסר ללקוחה' : o.status === 'נשלח' ? 'נאסף מהמחסן' : null,
  };
}

function currentPlan() {
  return state.planId
    ? state.plans.find((p) => p.id === state.planId)
    : { name: '—', price: 0, points: 0 };
}

function courierOpts(planId = state.planId) {
  return {
    planId: planId || null,
    deliverySignatureRequired: planRequiresDeliverySignature(planId),
  };
}

export function getSnapshot() {
  pruneMyItems();
  reconcileCustomerUnits();
  pruneExchangeReturns();
  accrueSubscriptionCharges();
  const plan = currentPlan();
  const pointsTotal = state.planId ? plan.points : 0;
  const remaining = remainingPoints();
  const exchangeAvail = exchangeAvailablePoints();
  // Back-office data (stock levels, every order, customer list) is staff-only.
  // Undefined keys are dropped by res.json, so customers never receive them.
  const staff = isStaffViewer();

  return {
    subscribed: state.subscribed,
    plan,
    planId: state.planId,
    pointsBalance: state.pointsBalance,
    pointsTotal,
    pointsPct: pointsTotal ? Math.round((state.pointsBalance / pointsTotal) * 100) : 0,
    credits: computedCreditBalance(),
    creditMonths: creditMonthsOf(state.subscribedAt),
    creditPct: CREDIT_PCT,
    flash: state.flash,
    registration: state.registration
      ? {
          ...state.registration,
          name: state.registration.name || state.registration.fullName || state.currentUserName,
          address: state.address || state.registration.address || {},
          payment: paymentView(state.payment),
          subscribedAt: state.subscribedAt,
          idDocumentUploaded: Boolean(
            state.registration.idDocumentUploaded || hasIdDocument(state.registration.idDocumentUrl),
          ),
          signatureCompleted: Boolean(state.registration.signatureCompleted),
          nationalId: maskNationalIdForClient(state.registration.nationalId),
          termsAcceptedAt: state.registration.termsAcceptedAt || null,
          canceledAt: state.registration.canceledAt || state.address?.canceledAt || null,
          shippingCharges: state.shippingCharges || state.registration.shippingCharges || state.address?.shippingCharges || [],
          idDocumentUrl: undefined,
          signatureData: undefined,
        }
      : null,
    auth: state.currentUserId
      ? { userId: state.currentUserId, role: state.currentUserRole }
      : null,
    verify: {
      email: Boolean(process.env.RESEND_API_KEY),
      sms: Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          (process.env.TWILIO_FROM_NUMBER ||
            process.env.TWILIO_MESSAGING_SERVICE_SID ||
            process.env.TWILIO_VERIFY_SID),
      ),
    },
    cart: state.cart.map((id) => product(id)).filter(Boolean),
    cartTotal: cartPoints(),
    remaining,
    membershipTerms: state.membershipTerms || [],
    plans: state.plans.map((p) => ({
      ...p,
      shippingLabel: p.shipping ? 'משלוח כלול' : 'משלוח בתשלום',
      deliverySignatureRequired: planRequiresDeliverySignature(p.id),
      deliverySignatureLabel: planRequiresDeliverySignature(p.id)
        ? 'חתימת מסירה נדרשת'
        : 'ללא חתימת מסירה',
    })),
    products: state.products
      .map((p) => {
        const avail = availableUnitsForProduct(p.id).length;
        return {
          ...p,
          inStock: avail > 0,
          availLabel: avail > 0 ? 'זמין' : 'אין במלאי',
          ...(isStaffViewer() ? { availCount: avail } : {}),
        };
      }),
    catalogProducts: state.products
      .map((p) => decorateProduct(p, remaining, state.cart)),
    exchangeCatalog: state.products
      .map((p) => decorateProduct(p, exchangeAvail, state.exchangeCart))
      .filter((p) => isStaffViewer() || p.inStock || p.inCart),
    myItems: state.myItems
      .map((uid) => {
        const u = unit(uid);
        if (!u) return null;
        if (u.status !== 'אצל לקוחה') return null;
        const p = product(u.modelId);
        if (!p) return null;
        const st = STATUS_STYLE[u.status] || { bg: '#EEE', fg: '#555' };
        return {
          unitId: u.id,
          name: p.name,
          category: p.category,
          metal: p.metal,
          stone: p.stone,
          points: p.points,
          price: p.price,
          productId: p.id,
          sku: p.id,
          status: u.status,
          badgeBg: st.bg,
          badgeFg: st.fg,
        };
      })
      .filter(Boolean),
    returnCandidates: state.myItems
      .map((uid) => unit(uid))
      .filter((u) => u && u.status === 'אצל לקוחה')
      .map((u) => {
        const p = product(u.modelId);
        if (!p) return null;
        const checked = state.exchangeReturns.includes(u.id);
        return {
          unitId: u.id,
          name: p.name,
          category: p.category,
          points: p.points,
          checked,
          checkedLabel: checked ? 'מסומן להחזרה' : 'ברשותך',
        };
      })
      .filter(Boolean),
    exchangeCart: state.exchangeCart.map((id) => product(id)).filter(Boolean),
    exchangeAvail,
    orders: staff ? state.orders.map(decorateOrder) : undefined,
    myOrders: state.orders.filter(isMyOrder).map(decorateCustomerOrder),
    myActiveOrders: state.orders
      .filter(isMyOrder)
      .map(decorateCustomerOrder)
      .filter((o) => o.isActive),
    myPurchases: (state.purchases || []).filter((p) =>
      state.currentUserId ? p.userId === state.currentUserId : !p.userId,
    ),
    purchases: staff ? state.purchases || [] : undefined,
    pastRentals: state.orders
      .filter(isMyOrder)
      .flatMap((o) =>
        (o.returnItems || []).map((uid) => {
          const u = unit(uid);
          const p = u ? product(u.modelId) : product(String(uid).split('-')[0]);
          if (!p) return null;
          return {
            serial: uid,
            product: p,
            orderId: o.id,
            date: o.date,
            returnedAt: o.date,
          };
        }),
      )
      .filter(Boolean),
    // Manager customers table: seed fixtures only (demo user stays in /account)
    customers: staff
      ? (state.staffCustomers?.length ? state.staffCustomers : state.seedCustomers)
      : undefined,
    inventory: staff
      ? state.products.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          units: state.units
            .filter((u) => u.modelId === p.id && !u.demoOnly)
            .map((u) => {
              const st = STATUS_STYLE[u.status] || { bg: '#EEE', fg: '#555' };
              return { ...u, badgeBg: st.bg, badgeFg: st.fg };
            }),
        }))
      : undefined,
    statuses: STATUSES,
    warehouseColumns: !staff
      ? undefined
      : (() => {
          const stageLabels = {
            ליקוט: 'הזמנות לליקוט',
            בקרה: 'בקרת איכות',
            אריזה: 'אריזה',
          };
          const nextLabels = {
            ליקוט: 'העבר לבקרת איכות',
            בקרה: 'העבר לאריזה',
            אריזה: 'סמן כנשלח',
          };
          const cols = ['ליקוט', 'בקרה', 'אריזה'].map((st) => ({
            key: st,
            label: stageLabels[st],
            orders: state.orders
              .filter((o) => normalizeFulfillmentStatus(o.status) === st)
              .map((o) => ({
                ...decorateOrder(o),
                nextLabel: nextLabels[normalizeFulfillmentStatus(o.status)],
              })),
          }));
          cols.push({
            key: 'נשלח',
            label: 'הושלם ונשלח',
            orders: state.orders
              .filter((o) => normalizeFulfillmentStatus(o.status) === 'נשלח')
              .map((o) => ({ ...decorateOrder(o), nextLabel: 'נשלח ✓' })),
          });
          return cols;
        })(),
    returnPouches: staff ? state.returnPouches.map(decoratePouch) : undefined,
    myReturnPouches: state.returnPouches
      .filter((p) => isMyPouch(p) && p.status !== 'completed')
      .map(decoratePouch),
    activeReturnPouches: staff
      ? state.returnPouches.filter((p) => p.status !== 'completed').map(decoratePouch)
      : undefined,
    shippingCharges: state.shippingCharges || state.address?.shippingCharges || [],
    extraShipFee: EXTRA_SHIP_FEE,
    nextShipFee: staff ? undefined : nextShipmentFee(),
    nextFreeShipmentAt: staff ? undefined : nextFreeShipmentAt(),
    charges: staff ? undefined : [...chargesLedger()].sort((a, b) => String(b.at).localeCompare(String(a.at))),
    paymentUsable: staff ? undefined : !isDbEnabled || paymentIsUsable(state.payment),
    payment: paymentView(state.payment),
    billingIssue: staff
      ? undefined
      : chargesLedger().some((c) => c.status === 'נכשל' || (c.status === 'לגבייה' && c.attempts > 0)),
    lastPouch: (() => {
      if (!state.lastPouchId) return null;
      const p = state.returnPouches.find((x) => x.id === state.lastPouchId);
      return p ? decoratePouch(p) : null;
    })(),
    // Legacy unit list (units in transit not yet in a pouch)
    returnUnits: !staff
      ? undefined
      : state.units
          .filter((u) => u.status === 'בדרך חזרה')
          .map((u) => {
            const p = product(u.modelId);
            const pouch = state.returnPouches.find((x) => x.returnItems.includes(u.id));
            return {
              unitId: u.id,
              name: p.name,
              category: p.category,
              qr: pouch?.qr || null,
              pouchId: pouch?.id || null,
            };
          }),
    cleaningUnits: !staff
      ? undefined
      : state.units.filter((u) => u.status === 'בניקוי').map((u) => ({
          unitId: u.id,
          name: product(u.modelId).name,
        })),
    repairUnits: !staff
      ? undefined
      : state.units.filter((u) => u.status === 'בתיקון').map((u) => ({
          unitId: u.id,
          name: product(u.modelId).name,
        })),
  };
}

export function clearFlash() {
  state.flash = null;
}

/**
 * Demo-customer-only jewelry for return/exchange testing.
 * Uses dedicated units (demoOnly) so manager inventory/seed stock is untouched.
 * Skipped in database mode — shared demo IDs collide across real users.
 */
function seedDemoOwnedJewelry() {
  if (isDbEnabled) return [];

  const owned = [];

  for (const spec of DEMO_OWNED_UNITS) {
    if (!product(spec.modelId)) continue;
    let u = unit(spec.id);
    if (!u) {
      u = {
        id: spec.id,
        modelId: spec.modelId,
        status: 'אצל לקוחה',
        demoOnly: true,
        ownerUserId: state.currentUserId || null,
      };
      state.units.push(u);
    } else {
      u.status = 'אצל לקוחה';
      u.demoOnly = true;
    }
    if (!state.myItems.includes(spec.id)) {
      state.myItems.push(spec.id);
    }
    owned.push(spec.id);
  }

  const spent = owned.reduce((sum, uid) => sum + product(unit(uid).modelId).points, 0);
  state.pointsBalance = Math.max(0, state.pointsBalance - spent);
  return owned;
}

/**
 * Starts (or restarts) a membership. Customers must arrive with the first month
 * already charged (`paid`); staff can reactivate and let billing collect it.
 */
export function subscribe(planId, { byStaff = false, paid = null } = {}) {
  const plan = resolvePlan(planId);
  if (!plan) throw new Error('המסלול לא נמצא');
  if (state.subscribed && state.planId) {
    return changePlan(plan.id);
  }
  if (isDbEnabled && !byStaff && !paid) {
    throw paymentError('כדי להפעיל מנוי צריך לשלם את החודש הראשון');
  }
  const now = new Date().toISOString();
  state.subscribed = true;
  state.planId = plan.id;
  state.pointsBalance = Math.max(0, plan.points - pointsTiedUpInJewelry());
  state.subscribedAt = state.subscribedAt || now;
  state.address = { ...(state.address || {}), billingStart: now, canceledAt: null };
  if (state.registration) {
    state.registration.step = 7;
    state.registration.canceledAt = null;
    state.registration.suspended = false;
    state.registration.suspendedAt = null;
  }
  if (!isDbEnabled && (!state.myItems || state.myItems.length === 0)) {
    seedDemoOwnedJewelry();
    state.credits = 180;
  }
  accrueSubscriptionCharges();
  if (paid) {
    const first = chargesLedger().find(
      (c) => c.kind === 'subscription' && c.periodStart === now && c.status === 'לגבייה',
    );
    if (first) markChargePaid(first.id, paid);
  }
  state.flash = null;
  return getSnapshot();
}

export function planPrice(planId) {
  const plan = resolvePlan(planId);
  if (!plan) throw new Error('המסלול לא נמצא');
  return { id: plan.id, name: plan.name, price: Number(plan.price) || 0 };
}

export function changePlan(planId) {
  const plan = resolvePlan(planId);
  if (!plan) throw new Error('המסלול לא נמצא');
  if (!state.subscribed || !state.planId) {
    return subscribe(planId);
  }
  if (state.planId === plan.id) return getSnapshot();
  const held = pointsTiedUpInJewelry();
  const inBox = cartPoints();
  if (held + inBox > plan.points) {
    throw new Error(
      `במסלול ${plan.name} המכסה היא ${plan.points} נק׳, ואצלך כרגע ${held + inBox} נק׳. כדי לעבור אליו צריך קודם להחזיר תכשיט.`,
    );
  }
  const prev = currentPlan();
  state.planId = plan.id;
  state.pointsBalance = Math.max(0, plan.points - held);
  state.flash = `המסלול שלך עודכן מ-${prev.name} ל-${plan.name} ✓`;
  return getSnapshot();
}

function parseWhen(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isNaN(t)) return t;
  const he = String(value);
  if (he === 'היום') return Date.now();
  if (he === 'לפני יום') return Date.now() - DAY_MS;
  const daysAgo = he.match(/לפני\s+(\d+)\s+ימים/);
  if (daysAgo) return Date.now() - Number(daysAgo[1]) * DAY_MS;
  return null;
}

function chargesLedger() {
  return Array.isArray(state.address?.charges) ? state.address.charges : [];
}

function addCharge(entry) {
  const charge = {
    id: `CHG-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    at: new Date().toISOString(),
    status: 'לגבייה',
    ...entry,
  };
  state.address = { ...(state.address || {}), charges: [...chargesLedger(), charge] };
  return charge;
}

function updateCharge(id, patch) {
  state.address = {
    ...(state.address || {}),
    charges: chargesLedger().map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

export function markChargePaid(id, paid = {}) {
  updateCharge(id, {
    status: 'שולם',
    paidAt: new Date().toISOString(),
    transId: paid.transId || null,
    method: paid.method || null,
    lastError: null,
  });
}

const MAX_CHARGE_ATTEMPTS = 3;

export function markChargeFailed(id, message) {
  const charge = chargesLedger().find((c) => c.id === id);
  const attempts = (Number(charge?.attempts) || 0) + 1;
  updateCharge(id, {
    attempts,
    lastError: String(message || '').slice(0, 200),
    lastAttemptAt: new Date().toISOString(),
    status: attempts >= MAX_CHARGE_ATTEMPTS ? 'נכשל' : 'לגבייה',
  });
}

export function markChargeRefunded(id, ok) {
  updateCharge(id, ok ? { status: 'בוטל', refundedAt: new Date().toISOString() } : { refundTried: true });
}

/** Gives charges that hit the retry limit another round (new card, or staff asked). */
export function retryFailedCharges() {
  state.address = {
    ...(state.address || {}),
    charges: chargesLedger().map((c) => (c.status === 'נכשל' ? { ...c, status: 'לגבייה', attempts: 0 } : c)),
  };
}

/** Charges the server should try to collect now. */
export function collectibleCharges() {
  return chargesLedger().filter(
    (c) => c.status === 'לגבייה' && Number(c.amount) > 0 && (Number(c.attempts) || 0) < MAX_CHARGE_ATTEMPTS,
  );
}

/** Paid charges that were cancelled and still need their money returned. */
export function chargesToRefund() {
  return chargesLedger().filter((c) => c.status === 'להחזר' && c.transId && !c.refundTried);
}

function voidChargesForOrder(orderId) {
  if (!orderId) return;
  state.address = {
    ...(state.address || {}),
    charges: chargesLedger().map((c) => {
      if (c.orderId !== orderId || c.status === 'בוטל') return c;
      return { ...c, status: c.status === 'שולם' ? 'להחזר' : 'בוטל' };
    }),
  };
  state.shippingCharges = (state.shippingCharges || []).filter((c) => c.relatedOrderId !== orderId);
  state.address.shippingCharges = state.shippingCharges;
  if (state.registration) state.registration.shippingCharges = state.shippingCharges;
}

function isPausedAt(t) {
  const pauses = Array.isArray(state.address?.pauses) ? state.address.pauses : [];
  return pauses.some((p) => {
    const from = parseWhen(p.from);
    const to = parseWhen(p.to);
    return from !== null && t >= from && (to === null || t < to);
  });
}

/**
 * Records the monthly fee for every 30-day period since billing started.
 * Existing subscribers without a billing start are billed from their next renewal,
 * so the ledger never invents past debt.
 */
export function accrueSubscriptionCharges(now = Date.now()) {
  if (!state.currentUserId && isDbEnabled) return;
  if (isStaffViewer() || !state.subscribed || !state.planId) return;
  const plan = currentPlan();
  if (!plan?.price) return;
  let origin = parseWhen(state.address?.billingStart);
  if (origin === null) {
    const joined = parseWhen(state.subscribedAt) ?? now;
    const elapsed = Math.max(0, now - joined);
    origin = joined + Math.ceil(elapsed / BILLING_PERIOD_MS) * BILLING_PERIOD_MS;
    state.address = { ...(state.address || {}), billingStart: new Date(origin).toISOString() };
  }
  const billed = new Set(
    chargesLedger().filter((c) => c.kind === 'subscription').map((c) => c.periodStart),
  );
  const fresh = [];
  for (let start = origin, n = 0; start <= now && n < 36; start += BILLING_PERIOD_MS, n += 1) {
    const key = new Date(start).toISOString();
    if (billed.has(key) || isPausedAt(start)) continue;
    fresh.push({
      id: `SUB-${key}`,
      kind: 'subscription',
      amount: Number(plan.price) || 0,
      description: `דמי מנוי חודשיים · ${plan.name}`,
      periodStart: key,
      at: key,
      status: 'לגבייה',
    });
  }
  if (fresh.length) {
    state.address = { ...(state.address || {}), charges: [...chargesLedger(), ...fresh] };
  }
}

/** When the customer last used her included shipment. The first box is part of joining. */
function lastIncludedShipmentAt() {
  const paid = new Set((state.shippingCharges || []).map((c) => c.relatedOrderId).filter(Boolean));
  let last = null;
  for (const o of state.orders) {
    if (!isMyOrder(o)) continue;
    const type = o.type || 'הזמנה';
    if (!SHIPMENT_TYPES.has(type) || type === 'הזמנה ראשונה') continue;
    if (paid.has(o.id)) continue;
    const t = parseWhen(o.date);
    if (t !== null && (last === null || t > last)) last = t;
  }
  return last;
}

/** One round trip every two months is included; each extra one costs EXTRA_SHIP_FEE. */
function nextShipmentFee(now = Date.now()) {
  const last = lastIncludedShipmentAt();
  return last !== null && now - last < SHIP_FREE_WINDOW_MS ? EXTRA_SHIP_FEE : 0;
}

function nextFreeShipmentAt() {
  const last = lastIncludedShipmentAt();
  if (last === null || Date.now() - last >= SHIP_FREE_WINDOW_MS) return null;
  return new Date(last + SHIP_FREE_WINDOW_MS).toISOString();
}

function itemsToCollect() {
  return state.myItems.filter((uid) => {
    const u = unit(uid);
    return u && (u.status === 'אצל לקוחה' || u.status === 'בדרך ללקוחה');
  });
}

function recordShipFee(reason, relatedOrderId, paid = null) {
  const charge = {
    id: `FEE-${Date.now()}`,
    amount: EXTRA_SHIP_FEE,
    reason,
    at: new Date().toISOString(),
    relatedOrderId: relatedOrderId || null,
  };
  state.shippingCharges = [...(state.shippingCharges || []), charge];
  if (!state.registration) state.registration = {};
  state.registration.shippingCharges = state.shippingCharges;
  state.address = { ...(state.address || {}), shippingCharges: state.shippingCharges };
  const entry = addCharge({
    kind: 'shipping',
    amount: EXTRA_SHIP_FEE,
    description: reason,
    orderId: relatedOrderId || null,
  });
  if (paid) markChargePaid(entry.id, paid);
  return charge;
}

function startEndPickup(endReason) {
  const existing = state.returnPouches.find((p) => isMyPouch(p) && p.status !== 'completed');
  if (existing) {
    existing.endReason = existing.endReason || endReason;
    return {
      pickupOrder: state.orders.find((o) => o.id === existing.orderId) || null,
      collected: [...(existing.returnItems || [])],
      reused: true,
    };
  }
  const returnItems = itemsToCollect();
  if (!returnItems.length) return { pickupOrder: null, collected: [], reused: false };

  const createdAt = new Date().toISOString();
  const orderId = `ORD-${state.orderCounter}${userIdSuffix()}`;
  const pouchId = `POUCH-${state.pouchCounter}${userIdSuffix()}`;
  const qr = makeQrCode();
  for (const uid of returnItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx > -1) state.units[idx] = { ...state.units[idx], status: 'בדרך חזרה' };
  }
  const order = attachCourierJob(
    {
      id: orderId,
      type: 'החזרה',
      userId: state.currentUserId || null,
      customerName: state.currentUserName || 'הלקוחה (דמו)',
      items: [],
      returnItems,
      status: 'אריזה',
      date: createdAt,
      qr,
      pouchId,
      endReason,
      newItems: [{ kind: 'end-pickup', reason: endReason }],
    },
    'pickup',
    courierOpts(),
  );
  state.orders.push(order);
  state.returnPouches.push({
    id: pouchId,
    userId: state.currentUserId || null,
    qr,
    orderId,
    customerName: order.customerName,
    returnItems,
    newItems: [],
    status: 'in_transit',
    scanned: false,
    createdAt,
    courierConfirmedAt: null,
    demoCustomer: true,
    pendingPoints: pointsForUnits(returnItems),
    pointsCredited: false,
    inventoryCleared: false,
    endReason,
  });
  state.lastPouchId = pouchId;
  state.pouchCounter += 1;
  state.orderCounter += 1;
  return { pickupOrder: order, collected: returnItems, reused: false };
}

function closeSubscription(mode) {
  accrueSubscriptionCharges();
  const feeDue = nextShipmentFee();
  const endReason = mode === 'suspend' ? 'הקפאה' : 'ביטול';
  const { pickupOrder, collected, reused } = startEndPickup(endReason);
  let fee = null;
  if (feeDue && pickupOrder && !reused) {
    fee = recordShipFee(
      mode === 'suspend'
        ? 'איסוף בהקפאת מנוי, אחרי שנוצל המשלוח הכלול'
        : 'איסוף בביטול מנוי, אחרי שנוצל המשלוח הכלול',
      pickupOrder.id,
    );
  }
  state.cart = [];
  state.exchangeReturns = [];
  state.exchangeCart = [];
  if (!state.registration) state.registration = {};
  const feeNote = fee ? ` · מחויבת ב-₪${EXTRA_SHIP_FEE} דמי משלוח` : '';
  const pickupNote = collected.length
    ? ' שליח יגיע לאסוף את התכשיטים בימים הקרובים.'
    : '';
  if (mode === 'suspend') {
    const at = new Date().toISOString();
    state.registration.suspendedAt = at;
    state.registration.suspended = true;
    const pauses = Array.isArray(state.address?.pauses) ? state.address.pauses : [];
    state.address = { ...(state.address || {}), pauses: [...pauses, { from: at, to: null }] };
    state.flash = `המנוי הוקפא.${pickupNote}${feeNote}`;
  } else {
    const lastPlanId = state.planId;
    state.subscribed = false;
    state.planId = null;
    state.pointsBalance = 0;
    state.registration.canceledAt = new Date().toISOString();
    state.address = {
      ...(state.address || {}),
      canceledAt: state.registration.canceledAt,
      lastPlanId,
    };
    state.flash = `המנוי בוטל.${pickupNote}${feeNote}`;
  }
  return {
    ...getSnapshot(),
    endSubscription: {
      mode,
      pickup: collected.length > 0,
      fee,
      itemCount: collected.length,
    },
  };
}

export function suspendOwnSubscription() {
  if (!state.subscribed) throw new Error('אין מנוי פעיל');
  if (isSuspended()) throw new Error('המנוי כבר מוקפא');
  return closeSubscription('suspend');
}

export function resumeOwnSubscription() {
  if (!isSuspended()) throw new Error('המנוי אינו מוקפא');
  if (state.registration) {
    state.registration.suspendedAt = null;
    state.registration.suspended = false;
  }
  const at = new Date().toISOString();
  const pauses = Array.isArray(state.address?.pauses) ? state.address.pauses : [];
  state.address = {
    ...(state.address || {}),
    pauses: pauses.map((p) => (p.to ? p : { ...p, to: at })),
  };
  accrueSubscriptionCharges();
  state.flash = 'המנוי הופעל מחדש ✓';
  return getSnapshot();
}

export function cancelSubscription() {
  if (!state.subscribed && !isSuspended()) throw new Error('אין מנוי פעיל');
  return closeSubscription('cancel');
}

/** Back-office actions run against a customer session loaded by the server. */
export function staffSubscriptionAction(action, planId) {
  if (action === 'suspend') return suspendOwnSubscription();
  if (action === 'resume') return resumeOwnSubscription();
  if (action === 'cancel') return cancelSubscription();
  if (action === 'reactivate') {
    if (state.subscribed && isSuspended()) return resumeOwnSubscription();
    if (state.subscribed) throw new Error('המנוי כבר פעיל');
    const target = planId || state.address?.lastPlanId;
    if (!target) throw new Error('יש לבחור מסלול להפעלה מחדש');
    return subscribe(target, { byStaff: true });
  }
  throw new Error('פעולה לא מוכרת');
}

export function staffUpdateCustomerDetails(patch = {}) {
  if (!state.registration) state.registration = {};
  const name = String(patch.name ?? '').trim();
  const phone = String(patch.phone ?? '').trim();
  if (name) {
    state.registration.fullName = name;
    state.currentUserName = name;
  }
  if (phone) state.registration.phone = phone;
  if (patch.address && typeof patch.address === 'object') {
    state.address = { ...(state.address || {}), ...clientAddress(patch.address) };
    state.registration.address = state.address;
  }
  return getSnapshot();
}

export function login() {
  if (!state.subscribed) {
    state.subscribed = true;
    state.planId = 'signature';
    state.pointsBalance = 800;
    state.myItems = [];
    seedDemoOwnedJewelry();
    state.credits = 180;
    state.subscribedAt = state.subscribedAt || new Date(Date.now() - 90 * DAY_MS).toISOString();
  } else if (state.myItems.length === 0) {
    seedDemoOwnedJewelry();
  }
  state.flash = 'ברוכה הבאה — יש לך תכשיטים לבדיקת החזרה/החלפה';
  return getSnapshot();
}

export function registerMock({
  fullName,
  email,
  phone,
  address,
  nationalId,
  idDocumentUrl,
  signatureData,
  signatureCompleted,
  termsAcceptedAt,
  privacyAcceptedAt,
  noticesAcceptedAt,
  signupIp,
}) {
  state.currentUserName = fullName;
  state.subscribed = false;
  state.planId = null;
  state.pointsBalance = 0;
  state.myItems = [];
  state.address = address || {};
  state.registration = {
    fullName,
    email,
    phone,
    address: address || {},
    step: 7,
    name: fullName,
    nationalId: nationalId || '',
    idDocumentUrl: idDocumentUrl || '',
    signatureData: signatureData || '',
    signatureCompleted: signatureCompleted ?? Boolean(signatureData),
    termsAcceptedAt: termsAcceptedAt || null,
    privacyAcceptedAt: privacyAcceptedAt || null,
    noticesAcceptedAt: noticesAcceptedAt || null,
    signupIp: signupIp || '',
  };
  return getSnapshot();
}

export function logout() {
  state.units = state.units.filter((u) => !u.demoOnly);
  state.returnPouches = state.returnPouches.filter((p) => !p.demoCustomer);
  state.orders = state.orders.filter((o) => o.customerName !== 'הלקוחה (דמו)');
  clearUserSession();
  return getSnapshot();
}

export function addToCart(productId) {
  if (isSuspended()) throw new Error('המנוי מושהה — לא ניתן להזמין');
  if (!state.subscribed || !state.planId) throw new Error('כדי להזמין תכשיטים צריך מנוי פעיל');
  if (state.cart.includes(productId)) return getSnapshot();
  const p = product(productId);
  if (!p) throw new Error('התכשיט לא נמצא');
  if (remainingPoints() < p.points) throw new Error('אין מספיק נקודות');
  if (availableUnitsForProduct(productId).length === 0) throw new Error('אין במלאי');
  state.cart.push(productId);
  return getSnapshot();
}

export function removeFromCart(productId) {
  state.cart = state.cart.filter((id) => id !== productId);
  return getSnapshot();
}

// Counters restart at the same value for every customer, so ids must be scoped
// to the user or one customer's upsert overwrites another's order or pouch.
function userIdSuffix() {
  if (!state.currentUserId) return '';
  return `-${state.currentUserId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

function makeQrCode() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `QR-${random}${userIdSuffix()}`;
}

function itemsHeldByCustomer() {
  return state.myItems.filter((uid) => {
    const u = unit(uid);
    return u && u.status === 'אצל לקוחה';
  });
}

function hasPriorBoxOrder() {
  if (itemsHeldByCustomer().length > 0) return true;
  return state.orders.some((o) => {
    if (!isMyOrder(o)) return false;
    const type = o.type || 'הזמנה';
    return type === 'הזמנה' || type === 'הזמנה ראשונה' || type === 'החלפה';
  });
}

function linkReturnPouch(order, returnItems) {
  const qr = makeQrCode();
  const pouchId = `POUCH-${state.pouchCounter}${userIdSuffix()}`;
  const createdAt = new Date().toISOString();
  for (const uid of returnItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx > -1) state.units[idx] = { ...state.units[idx], status: 'בדרך חזרה' };
  }
  state.returnPouches.push({
    id: pouchId,
    userId: state.currentUserId || null,
    qr,
    orderId: order.id,
    customerName: order.customerName,
    returnItems,
    newItems: order.items || [],
    status: 'in_transit',
    scanned: false,
    createdAt,
    courierConfirmedAt: null,
    demoCustomer: true,
    pendingPoints: pointsForUnits(returnItems),
    pointsCredited: false,
    inventoryCleared: false,
  });
  state.lastPouchId = pouchId;
  state.pouchCounter += 1;
  order.qr = qr;
  order.pouchId = pouchId;
  order.returnItems = returnItems;
}

/** Validates the box and returns what confirming it would cost, without changing anything. */
export function quoteOrder() {
  if (isSuspended()) throw new Error('המנוי מושהה — לא ניתן להזמין');
  if (hasOpenReturn()) throw new Error('לא ניתן לבצע כרגע החלפה חדשה — ההחזרה מההחלפה הקודמת עדיין לא הושלמה');
  if (!state.subscribed || !state.planId) throw new Error('כדי להזמין תכשיטים צריך מנוי פעיל');
  if (!state.cart.length) throw new Error('הסל ריק');
  if (remainingPoints() < 0) throw new Error('חריגה ממכסת הנקודות');
  const soldOut = state.cart.filter((pid) => availableUnitsForProduct(pid).length === 0);
  if (soldOut.length) {
    const names = soldOut.map((pid) => product(pid)?.name || pid).join(', ');
    throw new Error(`${names} אזל מהמלאי בינתיים. הסירי מהקופסה ונסי שוב`);
  }
  const orderType =
    state.exchangeReturns.length > 0 ? 'החלפה' : hasPriorBoxOrder() ? 'הזמנה' : 'הזמנה ראשונה';
  const shipFee = orderType === 'הזמנה ראשונה' ? 0 : nextShipmentFee();
  return { orderType, shipFee };
}

export function confirmOrder(payload = {}, { paid = null } = {}) {
  const { orderType, shipFee } = quoteOrder();
  if (shipFee && isDbEnabled && !paid) throw paymentError('יש לשלם את דמי המשלוח כדי להמשיך');
  const returnsInOrder = [...state.exchangeReturns];
  const notes = String(payload.notes ?? payload.address?.notes ?? '').trim();
  state.address = { ...(state.address || {}), notes };
  if (state.registration) {
    state.registration.address = { ...(state.registration.address || state.address || {}), notes };
  }
  const orderItems = [];
  for (const pid of state.cart) {
    const idx = state.units.findIndex((u) => u.modelId === pid && u.status === 'זמין');
    if (idx > -1) {
      state.units[idx] = {
        ...state.units[idx],
        status: 'בדרך ללקוחה',
        ownerUserId: state.currentUserId || null,
      };
      orderItems.push(state.units[idx].id);
    }
  }
  const spent = orderItems.reduce(
    (sum, uid) => sum + product(unit(uid).modelId).points,
    0,
  );
  const returnItems = returnsInOrder;
  const isExchange = returnItems.length > 0;
  const type = orderType;
  const newOrder = attachCourierJob(
    {
      id: `ORD-${state.orderCounter}${userIdSuffix()}`,
      type,
      userId: state.currentUserId || null,
      customerName: state.currentUserName || 'הלקוחה (דמו)',
      items: orderItems,
      returnItems,
      status: 'ליקוט',
      date: new Date().toISOString(),
    },
    isExchange ? 'both' : 'delivery',
    courierOpts(),
  );
  if (isExchange) linkReturnPouch(newOrder, returnItems);
  state.myItems = [...state.myItems, ...orderItems];
  state.cart = [];
  state.exchangeReturns = [];
  state.pointsBalance -= spent;
  state.orders.push(newOrder);
  state.orderCounter += 1;
  if (shipFee) {
    recordShipFee(
      isExchange ? 'משלוח החלפה נוסף בתוך חודשיים' : 'משלוח נוסף בתוך חודשיים',
      newOrder.id,
      paid,
    );
  }
  const feeNote = shipFee ? ` · דמי משלוח ₪${shipFee}` : '';
  state.flash = (isExchange
    ? 'החלפה בדרך — משלוח ואיסוף ✓'
    : type === 'הזמנה ראשונה'
      ? 'ההזמנה הראשונה בדרך — משלוח ✓'
      : 'ההזמנה בדרך — משלוח ✓') + feeNote;
  return getSnapshot();
}

/** Validates a purchase and prices it (credit applied) without changing anything. */
export function quotePurchase(payload = {}) {
  const pid = payload.productId || payload.pid;
  const serial = payload.serial || null;
  const p = product(pid);
  if (!p) throw new Error('לא נמצא');
  const guest = !state.currentUserId;
  const buyer = payload.buyer || null;
  if (guest && !(buyer && String(buyer.name || '').trim())) {
    throw new Error('צריך להתחבר או למלא פרטים');
  }
  if (guest && !String(buyer.phone || '').trim() && !String(buyer.email || '').trim()) {
    throw new Error('צריך למלא טלפון או אימייל ליצירת קשר');
  }
  const address = { ...(state.address || {}), ...clientAddress(payload.address) };
  if (!serial && !(address.street && address.houseNo && address.city)) {
    throw new Error('צריך למלא רחוב, מספר בית ועיר למשלוח');
  }

  let target = null;
  if (serial) {
    if (guest) throw new Error('כדי לקנות תכשיט שנמצא אצלך צריך להתחבר');
    target = unit(serial);
    if (!target || !state.myItems.includes(serial) || target.modelId !== p.id) {
      throw new Error('הפריט לא שייך לחשבון');
    }
    if (target.status !== 'אצל לקוחה') {
      throw new Error('אפשר לקנות רק תכשיט שנמצא אצלך, לא בדרך או בהחזרה');
    }
  } else {
    target = availableUnitsForProduct(pid)[0] || null;
  }
  if (!target) throw new Error('אין יחידה זמינה לרכישה');

  const price = Number(p.price) || 0;
  const balance = computedCreditBalance();
  const maxCredit = guest ? 0 : Math.min(balance, price);
  const wanted =
    payload.creditToUse === undefined || payload.creditToUse === null
      ? maxCredit
      : Number(payload.creditToUse);
  const creditUsed = guest
    ? 0
    : Math.min(maxCredit, Math.max(0, Number.isFinite(wanted) ? wanted : maxCredit));
  const toPay = Math.max(0, price - creditUsed);
  return { product: p, target, serial, guest, buyer, price, creditUsed, toPay, address };
}

export function purchaseItem(payload = {}, { paid = null } = {}) {
  const { product: p, target, serial, guest, buyer, price, creditUsed, toPay, address } =
    quotePurchase(payload);
  if (toPay > 0 && isDbEnabled && !paid) throw paymentError('יש להשלים את התשלום כדי לרכוש');
  const payment = paid?.card ? normalizePayment(paid.card) : normalizePayment(state.payment);
  if (!guest && payload.saveAddress && payload.address) {
    state.address = { ...(state.address || {}), ...clientAddress(payload.address) };
  }
  if (!guest) {
    state.creditsUsed = (state.creditsUsed || 0) + creditUsed;
    if (state.subscribedAt) {
      state.credits = computedCreditBalance();
    } else {
      state.credits = Math.max(0, (Number(state.credits) || 0) - creditUsed);
    }
  }

  const idx = state.units.findIndex((x) => x.id === target.id);
  if (idx > -1) {
    state.units[idx] = {
      ...state.units[idx],
      status: 'נמכר',
      ownerUserId: state.currentUserId || state.units[idx].ownerUserId || null,
    };
  }
  state.myItems = state.myItems.filter((id) => id !== target.id);
  state.exchangeReturns = state.exchangeReturns.filter((id) => id !== target.id);

  const needsShipping = !serial;
  state.purchaseCounter = (state.purchaseCounter || 0) + 1;
  const scope = guest ? `-G${Date.now().toString(36).toUpperCase()}` : userIdSuffix();
  const id = `PUR-${new Date().getFullYear()}-${String(state.purchaseCounter).padStart(4, '0')}${scope}`;
  const meta = {
    kind: 'purchase-meta',
    pid: p.id,
    name: p.name,
    sku: p.id,
    price,
    creditUsed,
    paid: toPay,
    address: clientAddress(address),
    payment,
    transId: paid?.transId || null,
    buyer,
    needsShipping,
    shippedAt: null,
  };
  const purchaseOrder = {
    id,
    type: 'רכישה',
    userId: state.currentUserId || null,
    customerName:
      payload.recipient || (buyer && buyer.name) || state.currentUserName || 'אורחת',
    items: [target.id],
    returnItems: [],
    newItems: [meta],
    status: needsShipping ? 'ליקוט' : 'נמסרה',
    date: new Date().toISOString(),
  };
  if (needsShipping) attachCourierJob(purchaseOrder, 'delivery', courierOpts());
  state.orders.unshift(purchaseOrder);
  rebuildPurchasesFromOrders();
  if (!guest && toPay > 0) {
    const entry = addCharge({ kind: 'purchase', amount: toPay, description: `רכישת ${p.name}`, orderId: id });
    if (paid) markChargePaid(entry.id, paid);
  }
  const msg =
    creditUsed > 0
      ? `הרכישה הושלמה! מומשו ₪${Math.round(creditUsed)} קרדיט · לתשלום ₪${Math.round(toPay)}`
      : `הרכישה הושלמה! לתשלום ₪${Math.round(toPay)} — ${p.name} בדרך אלייך`;
  state.flash = msg;
  return { ...getSnapshot(), purchase: { ok: true, msg, creditUsed, toPay } };
}

export function markPurchaseShipped(purchaseId) {
  const order = state.orders.find((o) => o.id === purchaseId);
  if (!order || order.type !== 'רכישה') throw new Error('רכישה לא נמצאה');
  const meta = (order.newItems || []).find((x) => x && x.kind === 'purchase-meta');
  if (meta) meta.shippedAt = new Date().toISOString();
  order.status = 'נשלח';
  rebuildPurchasesFromOrders();
  return getSnapshot();
}

export function toggleReturn(unitId) {
  if (!unitId) throw new Error('חסר מזהה פריט');
  const u = unit(unitId);
  if (!u) throw new Error('הפריט לא נמצא');
  if (u.status !== 'אצל לקוחה') throw new Error('ניתן להחזיר רק פריטים שאצלך');
  if (!state.myItems.includes(unitId)) throw new Error('הפריט לא שייך לחשבון');

  if (state.exchangeReturns.includes(unitId)) {
    state.exchangeReturns = state.exchangeReturns.filter((x) => x !== unitId);
  } else {
    state.exchangeReturns.push(unitId);
  }
  return getSnapshot();
}

export function addExchangeProduct(productId) {
  if (state.exchangeCart.includes(productId)) return getSnapshot();
  const p = product(productId);
  if (!p) throw new Error('התכשיט לא נמצא');
  if (exchangeAvailablePoints() < p.points) throw new Error('אין מספיק נקודות');
  if (availableUnitsForProduct(productId).length === 0) throw new Error('אין במלאי');
  state.exchangeCart.push(productId);
  return getSnapshot();
}

export function removeExchangeProduct(productId) {
  state.exchangeCart = state.exchangeCart.filter((id) => id !== productId);
  return getSnapshot();
}

function pointsForUnits(unitIds) {
  return unitIds.reduce((sum, uid) => {
    const u = unit(uid);
    const p = u ? product(u.modelId) : null;
    return sum + (p?.points || 0);
  }, 0);
}

/**
 * Customer creates return QR:
 * - items stay on customer inventory with status בדרך חזרה (shown as בתהליך החזרה)
 * - points are NOT credited yet — only after warehouse scans + confirms
 */
export function quoteExchange() {
  if (isSuspended()) throw new Error('המנוי מושהה — לא ניתן לבצע החלפה');
  if (hasOpenReturn()) throw new Error('לא ניתן לבצע כרגע החלפה חדשה — ההחזרה מההחלפה הקודמת עדיין לא הושלמה');
  if (!state.exchangeReturns.length) {
    throw new Error('יש לבחור לפחות פריט אחד להחזרה');
  }
  return { shipFee: nextShipmentFee() };
}

export function confirmExchange({ paid = null } = {}) {
  const { shipFee } = quoteExchange();
  if (shipFee && isDbEnabled && !paid) throw paymentError('יש לשלם את דמי המשלוח כדי להמשיך');
  const returnItems = [...state.exchangeReturns];
  for (const uid of returnItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx > -1) state.units[idx] = { ...state.units[idx], status: 'בדרך חזרה' };
  }

  const pendingPoints = pointsForUnits(returnItems);
  const qr = makeQrCode();
  const orderId = `ORD-${state.orderCounter}${userIdSuffix()}`;
  const pouchId = `POUCH-${state.pouchCounter}${userIdSuffix()}`;

  const createdAt = new Date().toISOString();
  state.orders.push(
    attachCourierJob(
      {
        id: orderId,
        type: 'החזרה',
        userId: state.currentUserId || null,
        customerName: state.currentUserName || 'הלקוחה (דמו)',
        items: [],
        returnItems,
        status: 'אריזה',
        date: createdAt,
        qr,
        pouchId,
      },
      'pickup',
      courierOpts(),
    ),
  );

  state.returnPouches.push({
    id: pouchId,
    userId: state.currentUserId || null,
    qr,
    orderId,
    customerName: state.currentUserName || 'הלקוחה (דמו)',
    returnItems,
    newItems: [],
    status: 'in_transit',
    scanned: false,
    createdAt,
    courierConfirmedAt: null,
    demoCustomer: true,
    pendingPoints,
    pointsCredited: false,
    inventoryCleared: false,
  });
  state.lastPouchId = pouchId;
  state.pouchCounter += 1;
  state.orderCounter += 1;
  state.exchangeReturns = [];
  state.exchangeCart = [];
  if (shipFee) recordShipFee('איסוף החזרה נוסף בתוך חודשיים', orderId, paid);
  state.flash =
    'החזרה נפתחה — נזמין שליח לאיסוף בלבד. הנקודות יזוכו אחרי סריקה במחסן' +
    (shipFee ? ` · דמי משלוח ₪${shipFee}` : '');
  return getSnapshot();
}

/** After warehouse confirms contents: remove from customer inventory + credit points once. */
function settlePouchForCustomer(pouch) {
  if (!pouch || pouch.inventoryCleared) return 0;

  for (const uid of pouch.returnItems) {
    state.myItems = state.myItems.filter((id) => id !== uid);
  }

  const credit =
    typeof pouch.pendingPoints === 'number'
      ? pouch.pendingPoints
      : pointsForUnits(pouch.returnItems);

  if (pouch.demoCustomer && !pouch.pointsCredited && credit > 0) {
    state.pointsBalance += credit;
    pouch.pointsCredited = true;
  }

  pouch.inventoryCleared = true;
  return credit;
}

export function scanPouch(qrCode) {
  const code = String(qrCode || '').trim().toUpperCase();
  const pouch = state.returnPouches.find(
    (p) => p.qr.toUpperCase() === code || p.id.toUpperCase() === code,
  );
  if (!pouch) throw new Error('קוד QR לא נמצא');
  if (pouch.status === 'completed') throw new Error('הנרתיק כבר טופל');
  pouch.scanned = true;
  if (pouch.status === 'in_transit') pouch.status = 'scanned';
  state.flash = `נסרק ${pouch.qr} — ${pouch.returnItems.length} פריטים צפויים`;
  return getSnapshot();
}

export function confirmPouchContents(pouchId) {
  const pouch = state.returnPouches.find((p) => p.id === pouchId);
  if (!pouch) throw new Error('נרתיק לא נמצא');
  if (pouch.status !== 'scanned') throw new Error('יש לסרוק את ה־QR תחילה');

  // Manager confirmed return: drop from customer inventory + restore points
  const credit = settlePouchForCustomer(pouch);
  pouch.status = 'contents_ok';

  state.flash = pouch.demoCustomer
    ? `תכולה אושרה — הפריטים הוסרו מהלקוחה ו־${credit} נקודות הוחזרו. עברו לבקרת איכות`
    : 'תכולת הנרתיק אושרה — עברו לבקרת איכות לכל פריט';
  return getSnapshot();
}

export function pouchItemQC(pouchId, unitId, result) {
  const pouch = state.returnPouches.find((p) => p.id === pouchId);
  if (!pouch) throw new Error('נרתיק לא נמצא');
  if (pouch.status !== 'contents_ok' && pouch.status !== 'scanned') {
    throw new Error('יש לאשר תכולה לפני בקרת איכות');
  }
  // If QC happens right after scan without explicit confirm, settle first
  if (pouch.status === 'scanned') {
    settlePouchForCustomer(pouch);
    pouch.status = 'contents_ok';
  }
  if (!pouch.returnItems.includes(unitId)) throw new Error('הפריט לא שייך לנרתיק');

  const status = result === 'ok' ? 'בניקוי' : 'בתיקון';
  state.units = state.units.map((u) => (u.id === unitId ? { ...u, status } : u));
  // Inventory/points already handled on confirm — do not credit again

  const allDone = pouch.returnItems.every((uid) => {
    const u = unit(uid);
    return u && u.status !== 'בדרך חזרה';
  });
  if (allDone) {
    pouch.status = 'completed';
    state.flash = `נרתיק ${pouch.qr} הושלם — כל הפריטים עברו בקרת איכות`;
  } else {
    state.flash = result === 'ok' ? 'הפריט הועבר לניקוי' : 'הפריט הועבר לתיקון';
  }
  return getSnapshot();
}

export function updateMembershipTerms(lines) {
  state.membershipTerms = saveMembershipTerms(lines);
  return getSnapshot();
}

export function updatePlan(id, field, value) {
  const allowed = ['price', 'points', 'maxItems', 'exchanges'];
  if (!allowed.includes(field)) throw new Error('שדה לא תקין');
  const target = resolvePlan(id);
  if (!target) throw new Error('המסלול לא נמצא');
  state.plans = state.plans.map((p) =>
    p.id === target.id ? { ...p, [field]: Number(value) || 0 } : p,
  );
  if (state.planId === id && field === 'points') {
    // keep demo simple — do not auto-adjust balance
  }
  return getSnapshot();
}

export function productCodeOf(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function assertProductCode(value) {
  const code = productCodeOf(value);
  if (!code) throw new Error('חסר מק״ט');
  if (!/^[A-Z0-9\-_.]+$/.test(code)) throw new Error('מק״ט יכול להכיל רק אותיות באנגלית, ספרות ומקף');
  return code;
}

function codeTaken(code, exceptModelId = null) {
  if (state.units.some((u) => productCodeOf(u.id) === code)) return true;
  return skuTaken(code, exceptModelId);
}

export function createProduct(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('חסר שם תכשיט');
  const category = String(input.category || 'טבעות').trim();
  const id = assertProductCode(input.sku || input.id);
  if (codeTaken(id)) throw new Error('מק״ט כבר קיים');
  state.products.push({
    id,
    sku: id,
    name,
    category,
    metal: input.metal || 'כסף 925',
    stone: input.stone || 'מויסנייט',
    points: Number(input.points) || 30,
    price: Number(input.price) || 0,
  });
  // The chosen code is the barcode of the first piece. No separate number.
  state.units.push({
    id,
    modelId: id,
    status: 'זמין',
    demoOnly: false,
  });
  return getSnapshot();
}

function normalizeSku(value) {
  return productCodeOf(value);
}

function skuTaken(sku, exceptId = null) {
  const wanted = normalizeSku(sku);
  if (!wanted) return false;
  return state.products.some(
    (p) => p.id !== exceptId && (normalizeSku(p.sku || p.id) === wanted || normalizeSku(p.id) === wanted),
  );
}

export function updateProduct(id, field, value) {
  const numeric = ['points', 'price'];
  const text = ['name', 'category', 'metal', 'stone'];
  if (!product(id)) throw new Error('התכשיט לא נמצא');
  if (field === 'sku') {
    const sku = assertProductCode(value || id);
    const usedByOtherPiece = state.units.some((u) => productCodeOf(u.id) === sku && u.modelId !== id);
    if (usedByOtherPiece || skuTaken(sku, id)) throw new Error('מק״ט כבר קיים');
    state.products = state.products.map((p) => (p.id === id ? { ...p, sku } : p));
    return getSnapshot();
  }
  if (![...numeric, ...text].includes(field)) throw new Error('שדה לא תקין');
  state.products = state.products.map((p) =>
    p.id === id ? { ...p, [field]: numeric.includes(field) ? Number(value) || 0 : String(value ?? '') } : p,
  );
  return getSnapshot();
}

export function setUnitStatus(unitId, status) {
  if (!STATUSES.includes(status)) throw new Error('סטטוס לא תקין');
  state.units = state.units.map((u) => (u.id === unitId ? { ...u, status } : u));
  return getSnapshot();
}

function stampCourierHandover(order, at = new Date().toISOString()) {
  order.courierConfirmedAt = at;
  state.orders = state.orders.map((o) =>
    o.id === order.id ? { ...o, courierConfirmedAt: at } : o,
  );
  state.returnPouches = state.returnPouches.map((pouch) => {
    if (pouch.status === 'completed' || pouch.scanned) return pouch;
    const sameOrder = pouch.orderId === order.id || order.pouchId === pouch.id;
    if (!sameOrder) return pouch;
    return { ...pouch, courierConfirmedAt: at };
  });
}

export function advanceOrder(orderId) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new Error('ההזמנה לא נמצאה');
  const currentStatus = normalizeFulfillmentStatus(order.status);
  const idx = STAGES.indexOf(currentStatus);
  if (idx < 0) {
    throw new Error('לא ניתן לקדם את ההזמנה מהסטטוס הנוכחי');
  }
  if (idx >= STAGES.length - 1) {
    throw new Error('ההזמנה כבר נשלחה');
  }
  const next = STAGES[idx + 1];
  state.orders = state.orders.map((o) =>
    o.id === orderId ? { ...o, status: next } : o,
  );
  if (next === 'נשלח') {
    const current = state.orders.find((o) => o.id === orderId) || order;
    stampCourierHandover(current);
    state.orders = state.orders.map((o) =>
      o.id === orderId
        ? { ...o, status: next, tracking: trackingFor({ ...o, status: next }) }
        : o,
    );
    state.units = state.units.map((u) =>
      orderOwnsUnit(order, u.id) ? { ...u, status: 'אצל לקוחה' } : u,
    );
    return getSnapshot();
  }
  return getSnapshot();
}

export function receiveUnit(modelId, code) {
  if (!product(modelId)) throw new Error('התכשיט לא נמצא');
  const model = product(modelId);
  let id = String(code ?? '').trim() ? assertProductCode(code) : '';
  if (!id) {
    const base = productCodeOf(model.sku || modelId);
    let n = state.units.filter((u) => u.modelId === modelId && !u.demoOnly).length;
    id = `${base}-${n + 1}`;
    while (state.units.some((u) => u.id === id)) {
      n += 1;
      id = `${base}-${n + 1}`;
    }
  } else if (codeTaken(id, modelId)) {
    throw new Error('הקוד כבר קיים');
  }
  state.units.push({ id, modelId, status: 'זמין', demoOnly: false });
  return getSnapshot();
}

export function returnQC(unitId, result) {
  // Prefer pouch-based QC when a pouch owns this unit
  const pouch = state.returnPouches.find(
    (p) => p.returnItems.includes(unitId) && p.status !== 'completed',
  );
  if (pouch) {
    if (pouch.status === 'in_transit') {
      pouch.scanned = true;
      pouch.status = 'scanned';
    }
    return pouchItemQC(pouch.id, unitId, result);
  }
  const status = result === 'ok' ? 'בניקוי' : 'בתיקון';
  state.units = state.units.map((u) => (u.id === unitId ? { ...u, status } : u));
  state.myItems = state.myItems.filter((id) => id !== unitId);
  return getSnapshot();
}

export function clearLastPouch() {
  state.lastPouchId = null;
  return getSnapshot();
}

/** Customer cancels return before warehouse scan — items stay with customer. */
export function cancelReturnPouch(pouchId) {
  const pouch = state.returnPouches.find((p) => p.id === pouchId);
  if (!pouch) throw new Error('נרתיק לא נמצא');
  if (!pouch.demoCustomer || !isMyPouch(pouch)) throw new Error('לא ניתן לבטל נרתיק זה');
  if (pouch.status !== 'in_transit') {
    throw new Error('לא ניתן לבטל — הנרתיק כבר נסרק במחסן');
  }
  const linked = state.orders.find((o) => o.id === pouch.orderId || o.pouchId === pouchId);
  const endPickup = pouch.endReason || (linked?.newItems || []).some((x) => x && x.kind === 'end-pickup');
  if (endPickup) {
    throw new Error('איסוף של סיום או הקפאת מנוי לא ניתן לביטול כאן. פני לשירות הלקוחות');
  }
  if (linked && DELIVERED_STATUSES.has(linked.status)) {
    throw new Error('השליח כבר יצא. אפשר לתת לו את הנרתיק או לפנות לשירות הלקוחות');
  }

  for (const uid of pouch.returnItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx > -1) {
      state.units[idx] = { ...state.units[idx], status: 'אצל לקוחה' };
    }
    state.exchangeReturns = state.exchangeReturns.filter((x) => x !== uid);
  }

  state.returnPouches = state.returnPouches.filter((p) => p.id !== pouchId);
  state.deletedPouchIds = [...(state.deletedPouchIds || []), pouchId];
  if (linked && (linked.items || []).length > 0) {
    // Exchange: the new jewelry still ships; only the pickup half is dropped.
    linked.returnItems = [];
    linked.pouchId = null;
    linked.qr = null;
    linked.type = 'הזמנה';
    attachCourierJob(linked, 'delivery', courierOpts());
  } else if (linked) {
    voidChargesForOrder(linked.id);
    state.orders = state.orders.filter((o) => o.id !== linked.id);
    state.deletedOrderIds = [...(state.deletedOrderIds || []), linked.id];
  }
  if (state.lastPouchId === pouchId) {
    state.lastPouchId = null;
  }

  state.flash = 'ההחזרה בוטלה — התכשיטים נשארו אצלך';
  return getSnapshot();
}

export function markCleanAvailable(unitId) {
  state.units = state.units.map((u) =>
    u.id === unitId ? { ...u, status: 'זמין' } : u,
  );
  return getSnapshot();
}

export function resetStore() {
  state = makeInitialState();
  return getSnapshot();
}

export { STATUSES };

import { isDbEnabled } from './supabase.js';

const STATUSES = ['זמין', 'שמור', 'אצל לקוחה', 'בניקוי', 'בתיקון', 'בדרך ללקוחה', 'בדרך חזרה'];
const STAGES = ['ליקוט', 'בקרה', 'אריזה', 'נשלח'];

const STATUS_STYLE = {
  זמין: { bg: '#EDF3EA', fg: '#3E5C3F' },
  שמור: { bg: '#EFEBE4', fg: '#6B6157' },
  'אצל לקוחה': { bg: '#F6EEDD', fg: '#8A6A2A' },
  בניקוי: { bg: '#EAF0F2', fg: '#3E6470' },
  בתיקון: { bg: '#F7E9E4', fg: '#8C4A34' },
  'בדרך ללקוחה': { bg: '#FBF6EC', fg: '#A9812F' },
  'בדרך חזרה': { bg: '#F3EAF0', fg: '#7A4A68' },
};

function makeInitialState() {
  const unitMap = {
    'R21-1': 'זמין', 'R21-2': 'אצל לקוחה', 'R21-3': 'בניקוי',
    'R34-1': 'זמין', 'R34-2': 'זמין', 'R34-3': 'בתיקון',
    'N14-1': 'זמין', 'N14-2': 'שמור', 'N14-3': 'אצל לקוחה',
    'N08-1': 'זמין', 'N08-2': 'זמין', 'N08-3': 'בדרך ללקוחה',
    'E08-1': 'זמין', 'E08-2': 'בניקוי', 'E08-3': 'זמין',
    'E19-1': 'זמין', 'E19-2': 'אצל לקוחה', 'E19-3': 'זמין',
    'B33-1': 'זמין', 'B33-2': 'זמין', 'B33-3': 'בדרך חזרה',
    'B12-1': 'זמין', 'B12-2': 'זמין', 'B12-3': 'שמור',
  };

  return {
    subscribed: false,
    planId: null,
    pointsBalance: 0,
    credits: 180,
    cart: [],
    exchangeReturns: [],
    exchangeCart: [],
    myItems: [],
    flash: null,
    orderCounter: 1043,
    plans: [
      { id: 'essentials', name: 'Essentials', price: 249, points: 400, maxItems: 2, exchanges: 1, shipping: false, tagline: 'להתחיל להתנסות' },
      { id: 'signature', name: 'Signature', price: 449, points: 800, maxItems: 4, exchanges: 2, shipping: true, tagline: 'הבחירה הפופולרית' },
      { id: 'prestige', name: 'Prestige', price: 749, points: 1400, maxItems: 6, exchanges: 4, shipping: true, tagline: 'לגרדרובה עשירה' },
    ],
    products: [
      { id: 'R21', name: 'טבעת אמה', category: 'טבעות', metal: 'זהב צהוב', stone: 'זירקון', points: 220, price: 1200 },
      { id: 'R34', name: 'טבעת נועה', category: 'טבעות', metal: 'כסף', stone: 'אבן ירח', points: 150, price: 780 },
      { id: 'N14', name: 'שרשרת ליה', category: 'שרשראות', metal: 'זהב רוזה', stone: 'פנינה', points: 300, price: 1600 },
      { id: 'N08', name: 'שרשרת תמר', category: 'שרשראות', metal: 'כסף', stone: 'ללא אבן', points: 180, price: 950 },
      { id: 'E08', name: 'עגילי מאיה', category: 'עגילים', metal: 'זהב צהוב', stone: 'יהלום', points: 260, price: 1450 },
      { id: 'E19', name: 'עגילי רון', category: 'עגילים', metal: 'כסף', stone: 'אבן חן כחולה', points: 140, price: 690 },
      { id: 'B33', name: 'צמיד שני', category: 'צמידים', metal: 'זהב רוזה', stone: 'זירקון', points: 200, price: 1100 },
      { id: 'B12', name: 'צמיד עדן', category: 'צמידים', metal: 'כסף', stone: 'ללא אבן', points: 130, price: 620 },
    ],
    units: Object.entries(unitMap).map(([id, status]) => ({
      id,
      modelId: id.split('-')[0],
      status,
      demoOnly: false,
    })),
    orders: [
      { id: 'ORD-1041', type: 'הזמנה', customerName: 'נועה כהן', items: ['N08-3'], status: 'אריזה', date: 'לפני 2 ימים' },
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
    // Manager fixtures only — not the interactive demo customer
    seedCustomers: [
      { name: 'נועה כהן', plan: 'Signature', points: '520/800', status: 'פעיל' },
      { name: 'תמר לוי', plan: 'Prestige', points: '1100/1400', status: 'פעיל' },
      { name: 'שני אברהם', plan: 'Essentials', points: '0/400', status: 'מוקפא' },
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
      pouch.status === 'in_transit',
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
  const seed = orders.filter((o) => !o.userId);
  const user = orders.filter((o) => o.userId);
  state.orders = [...seed, ...user];
}

export function mergePouches(pouches) {
  const seed = pouches.filter((p) => !p.userId);
  const user = pouches.filter((p) => p.userId);
  state.returnPouches = [...seed, ...user];
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
  return state.cart.reduce((sum, id) => sum + product(id).points, 0);
}

function remainingPoints() {
  return state.pointsBalance - cartPoints();
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

/** Fix units still marked זמין while listed on the customer's account. */
function reconcileCustomerUnits() {
  if (!state.currentUserId) return;
  for (const uid of state.myItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx < 0) continue;
    const u = state.units[idx];
    if (u.status === 'זמין' || u.status === 'בדרך ללקוחה') {
      state.units[idx] = {
        ...u,
        status: 'אצל לקוחה',
        ownerUserId: state.currentUserId,
      };
    }
  }
  if (!isDbEnabled) return;
  for (const o of state.orders) {
    if (o.userId !== state.currentUserId || o.type !== 'הזמנה') continue;
    if (o.status === 'נשלח') continue;
    if ((o.items || []).some((uid) => state.myItems.includes(uid))) {
      o.status = 'נשלח';
    }
  }
}

function decorateProduct(p, budget, cartArr) {
  const avail = availableUnitsForProduct(p.id).length;
  const inCart = cartArr.includes(p.id);
  const disabled = !inCart && (avail === 0 || budget < p.points);
  return {
    ...p,
    availCount: avail,
    availLabel: avail > 0 ? `זמין (${avail})` : 'אין במלאי',
    inCart,
    addDisabled: disabled,
    buttonLabel: inCart ? 'בסל ✓' : disabled ? 'לא ניתן' : 'הוסיפי לסל',
  };
}

function decorateOrder(o) {
  return {
    ...o,
    itemsLabel: o.items
      .map((uid) => {
        const u = unit(uid);
        return u ? product(u.modelId).name : uid;
      })
      .join(', '),
  };
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
    'בדרך ללקוחה': 'בדרך אליי',
    'בדרך חזרה': 'בתהליך החזרה',
  };
  return labels[status] || status;
}

function decorateCustomerOrder(o) {
  const base = decorateOrder(o);
  const isPurchase = o.type === 'הזמנה';
  const isActive = isPurchase ? o.status !== 'נשלח' : o.status === 'בדרך חזרה';
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
  };
}

function currentPlan() {
  return state.planId
    ? state.plans.find((p) => p.id === state.planId)
    : { name: '—', price: 0, points: 0 };
}

export function getSnapshot() {
  pruneMyItems();
  reconcileCustomerUnits();
  pruneExchangeReturns();
  const plan = currentPlan();
  const pointsTotal = state.planId ? plan.points : 0;
  const remaining = remainingPoints();
  const exchangeAvail = exchangeAvailablePoints();

  return {
    subscribed: state.subscribed,
    plan,
    planId: state.planId,
    pointsBalance: state.pointsBalance,
    pointsTotal,
    pointsPct: pointsTotal ? Math.round((state.pointsBalance / pointsTotal) * 100) : 0,
    credits: state.credits,
    flash: state.flash,
    registration: state.registration,
    auth: state.currentUserId
      ? { userId: state.currentUserId, role: state.currentUserRole }
      : null,
    cart: state.cart.map((id) => product(id)),
    cartTotal: cartPoints(),
    remaining,
    plans: state.plans.map((p) => ({
      ...p,
      shippingLabel: p.shipping ? 'משלוח כלול' : 'משלוח בתשלום',
    })),
    products: state.products.map((p) => ({
      ...p,
      availCount: availableUnitsForProduct(p.id).length,
      availLabel:
        availableUnitsForProduct(p.id).length > 0
          ? `זמין (${availableUnitsForProduct(p.id).length})`
          : 'אין במלאי',
    })),
    catalogProducts: state.products.map((p) => decorateProduct(p, remaining, state.cart)),
    exchangeCatalog: state.products.map((p) =>
      decorateProduct(p, exchangeAvail, state.exchangeCart),
    ),
    myItems: state.myItems
      .map((uid) => {
        const u = unit(uid);
        if (!u) return null;
        const p = product(u.modelId);
        if (!p) return null;
        const st = STATUS_STYLE[u.status] || { bg: '#EEE', fg: '#555' };
        return {
          unitId: u.id,
          name: p.name,
          category: p.category,
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
    exchangeCart: state.exchangeCart.map((id) => product(id)),
    exchangeAvail,
    orders: state.orders.map(decorateOrder),
    myOrders: state.orders.filter(isMyOrder).map(decorateCustomerOrder),
    myActiveOrders: state.orders
      .filter(isMyOrder)
      .map(decorateCustomerOrder)
      .filter((o) => o.isActive),
    // Manager customers table: seed fixtures only (demo user stays in /account)
    customers: state.seedCustomers,
    inventory: state.products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      units: state.units
        .filter((u) => u.modelId === p.id && !u.demoOnly)
        .map((u) => {
          const st = STATUS_STYLE[u.status] || { bg: '#EEE', fg: '#555' };
          return { ...u, badgeBg: st.bg, badgeFg: st.fg };
        }),
    })),
    statuses: STATUSES,
    warehouseColumns: (() => {
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
          .filter((o) => o.status === st)
          .map((o) => ({ ...decorateOrder(o), nextLabel: nextLabels[o.status] })),
      }));
      cols.push({
        key: 'נשלח',
        label: 'הושלם ונשלח',
        orders: state.orders
          .filter((o) => o.status === 'נשלח')
          .map((o) => ({ ...decorateOrder(o), nextLabel: 'נשלח ✓' })),
      });
      return cols;
    })(),
    returnPouches: state.returnPouches.map(decoratePouch),
    myReturnPouches: state.returnPouches
      .filter((p) => isMyPouch(p) && p.status !== 'completed')
      .map(decoratePouch),
    activeReturnPouches: state.returnPouches
      .filter((p) => p.status !== 'completed')
      .map(decoratePouch),
    lastPouch: (() => {
      if (!state.lastPouchId) return null;
      const p = state.returnPouches.find((x) => x.id === state.lastPouchId);
      return p ? decoratePouch(p) : null;
    })(),
    // Legacy unit list (units in transit not yet in a pouch)
    returnUnits: state.units
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
    cleaningUnits: state.units
      .filter((u) => u.status === 'בניקוי')
      .map((u) => ({
        unitId: u.id,
        name: product(u.modelId).name,
      })),
    repairUnits: state.units
      .filter((u) => u.status === 'בתיקון')
      .map((u) => ({
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

export function subscribe(planId) {
  const plan = state.plans.find((p) => p.id === planId);
  if (!plan) throw new Error('Plan not found');
  state.subscribed = true;
  state.planId = planId;
  state.pointsBalance = plan.points;
  state.myItems = [];
  if (state.registration) state.registration.step = 7;
  seedDemoOwnedJewelry();
  state.flash = null;
  return getSnapshot();
}

export function login() {
  if (!state.subscribed) {
    state.subscribed = true;
    state.planId = 'signature';
    state.pointsBalance = 800;
    state.myItems = [];
    seedDemoOwnedJewelry();
  } else if (state.myItems.length === 0) {
    seedDemoOwnedJewelry();
  }
  state.flash = 'ברוכה הבאה — יש לך תכשיטים לבדיקת החזרה/החלפה';
  return getSnapshot();
}

export function registerMock({ fullName, email }) {
  state.currentUserName = fullName;
  state.registration = { fullName, email, step: 7 };
  return login();
}

export function logout() {
  state.units = state.units.filter((u) => !u.demoOnly);
  state.returnPouches = state.returnPouches.filter((p) => !p.demoCustomer);
  state.orders = state.orders.filter((o) => o.customerName !== 'הלקוחה (דמו)');
  clearUserSession();
  return getSnapshot();
}

export function addToCart(productId) {
  if (state.cart.includes(productId)) return getSnapshot();
  const p = product(productId);
  if (!p) throw new Error('Product not found');
  if (remainingPoints() < p.points) throw new Error('אין מספיק נקודות');
  if (availableUnitsForProduct(productId).length === 0) throw new Error('אין במלאי');
  state.cart.push(productId);
  return getSnapshot();
}

export function removeFromCart(productId) {
  state.cart = state.cart.filter((id) => id !== productId);
  return getSnapshot();
}

export function confirmOrder() {
  if (!state.cart.length) throw new Error('הסל ריק');
  const orderItems = [];
  const unitStatus = isDbEnabled ? 'אצל לקוחה' : 'בדרך ללקוחה';
  for (const pid of state.cart) {
    const idx = state.units.findIndex((u) => u.modelId === pid && u.status === 'זמין');
    if (idx > -1) {
      state.units[idx] = {
        ...state.units[idx],
        status: unitStatus,
        ownerUserId: state.currentUserId || null,
      };
      orderItems.push(state.units[idx].id);
    }
  }
  const spent = orderItems.reduce(
    (sum, uid) => sum + product(unit(uid).modelId).points,
    0,
  );
  const newOrder = {
    id: `ORD-${state.orderCounter}`,
    type: 'הזמנה',
    userId: state.currentUserId || null,
    customerName: state.currentUserName || 'הלקוחה (דמו)',
    items: orderItems,
    status: isDbEnabled ? 'נשלח' : 'ליקוט',
    date: 'היום',
  };
  state.myItems = [...state.myItems, ...orderItems];
  state.cart = [];
  state.pointsBalance -= spent;
  state.orders.push(newOrder);
  state.orderCounter += 1;
  state.flash = 'ההזמנה בדרך ✓';
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
  if (!p) throw new Error('Product not found');
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
export function confirmExchange() {
  if (!state.exchangeReturns.length) {
    throw new Error('יש לבחור לפחות פריט אחד להחזרה');
  }
  const returnItems = [...state.exchangeReturns];
  for (const uid of returnItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx > -1) state.units[idx] = { ...state.units[idx], status: 'בדרך חזרה' };
  }

  const pendingPoints = pointsForUnits(returnItems);
  const qr = `QR-${Math.floor(1000 + Math.random() * 9000)}`;
  const orderId = `ORD-${state.orderCounter}`;
  const pouchId = `POUCH-${state.pouchCounter}`;

  state.orders.push({
    id: orderId,
    type: 'החזרה',
    userId: state.currentUserId || null,
    customerName: state.currentUserName || 'הלקוחה (דמו)',
    items: [],
    returnItems,
    status: 'בדרך חזרה',
    date: 'היום',
    qr,
    pouchId,
  });

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
    createdAt: 'היום',
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
  state.flash =
    'תהליך החזרה החל, ברגע שהחבילה תוחזר ותאושר על ידינו תזוכה בנקודות חזרה';
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

export function updatePlan(id, field, value) {
  const allowed = ['price', 'points', 'maxItems', 'exchanges'];
  if (!allowed.includes(field)) throw new Error('Invalid field');
  state.plans = state.plans.map((p) =>
    p.id === id ? { ...p, [field]: Number(value) || 0 } : p,
  );
  if (state.planId === id && field === 'points') {
    // keep demo simple — do not auto-adjust balance
  }
  return getSnapshot();
}

export function updateProduct(id, field, value) {
  const allowed = ['points', 'price'];
  if (!allowed.includes(field)) throw new Error('Invalid field');
  state.products = state.products.map((p) =>
    p.id === id ? { ...p, [field]: Number(value) || 0 } : p,
  );
  return getSnapshot();
}

export function setUnitStatus(unitId, status) {
  if (!STATUSES.includes(status)) throw new Error('Invalid status');
  state.units = state.units.map((u) => (u.id === unitId ? { ...u, status } : u));
  return getSnapshot();
}

export function advanceOrder(orderId) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new Error('Order not found');
  const idx = STAGES.indexOf(order.status);
  if (idx < 0 || idx >= STAGES.length - 1) return getSnapshot();
  const next = STAGES[idx + 1];
  state.orders = state.orders.map((o) =>
    o.id === orderId ? { ...o, status: next } : o,
  );
  if (next === 'נשלח') {
    state.units = state.units.map((u) =>
      order.items.includes(u.id) ? { ...u, status: 'אצל לקוחה' } : u,
    );
  }
  return getSnapshot();
}

export function receiveUnit(modelId) {
  if (!product(modelId)) throw new Error('Product not found');
  // Skip demo-only serials when numbering manager stock
  const n = state.units.filter((u) => u.modelId === modelId && !u.demoOnly).length;
  state.units.push({ id: `${modelId}-${n + 1}`, modelId, status: 'זמין', demoOnly: false });
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
  if (!pouch.demoCustomer) throw new Error('לא ניתן לבטל נרתיק זה');
  if (pouch.status !== 'in_transit') {
    throw new Error('לא ניתן לבטל — הנרתיק כבר נסרק במחסן');
  }

  for (const uid of pouch.returnItems) {
    const idx = state.units.findIndex((u) => u.id === uid);
    if (idx > -1) {
      state.units[idx] = { ...state.units[idx], status: 'אצל לקוחה' };
    }
    state.exchangeReturns = state.exchangeReturns.filter((x) => x !== uid);
  }

  state.returnPouches = state.returnPouches.filter((p) => p.id !== pouchId);
  state.orders = state.orders.filter(
    (o) => o.pouchId !== pouchId && o.id !== pouch.orderId,
  );
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

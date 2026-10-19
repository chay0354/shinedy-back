import { randomBytes } from 'node:crypto';
import * as store from './store.js';
import * as hyp from './hyp.js';
import * as db from './db.js';
import { actAsCustomer, actAsGuest, isDbEnabled } from './session.js';

/**
 * How money is taken:
 * - 'hyp': real charges through the Hyp payment page and saved-card tokens.
 * - 'simulated': demo mode without a database; every payment succeeds.
 */
export function gatewayMode() {
  if (hyp.isHypConfigured()) return 'hyp';
  if (!isDbEnabled) return 'simulated';
  return 'off';
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function newPaymentId() {
  return `PAY-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function simulatedPaid() {
  return { transId: `SIM-${Date.now()}`, method: 'simulated' };
}

/** Charges the customer's saved card. Must run with the customer's session loaded. */
export async function chargeSavedCard(amount, info, ref) {
  const mode = gatewayMode();
  if (mode === 'simulated') return simulatedPaid();
  if (mode === 'off') throw httpError('התשלום אינו זמין כרגע', 503);
  const card = store.savedCard();
  if (!card) throw httpError('יש להוסיף כרטיס אשראי כדי להמשיך', 402);
  const userId = store.getMutableState().currentUserId || null;
  try {
    const r = await hyp.chargeToken({
      token: card.token,
      tokef: card.tokef,
      amount,
      info,
      order: ref,
      idNumber: card.holderId || store.billingContact().idNumber,
      client: store.billingContact(),
    });
    await db.logPayment({
      id: newPaymentId(),
      user_id: userId,
      kind: 'token',
      method: 'token',
      amount,
      status: 'paid',
      intent: { info, ref },
      provider_trans_id: r.transId,
    });
    return { transId: r.transId, method: 'token' };
  } catch (e) {
    if (e.ccode) {
      await db.logPayment({
        id: newPaymentId(),
        user_id: userId,
        kind: 'token',
        method: 'token',
        amount,
        status: 'failed',
        intent: { info, ref },
        error: `${e.ccode} ${e.message}`,
      });
    }
    throw e;
  }
}

async function voidPaid(paid) {
  if (!paid?.transId || paid.method === 'simulated') return true;
  return hyp.cancelTransaction(paid.transId);
}

/** Runs `commit(paid)` after charging `amount`; voids the charge if the commit fails. */
async function chargeThen(amount, info, ref, commit) {
  if (!(amount > 0)) return commit(null);
  const paid = await chargeSavedCard(amount, info, ref);
  try {
    return await commit(paid);
  } catch (e) {
    const voided = await voidPaid(paid);
    if (!voided) console.error('payment kept after failed commit:', paid.transId, e?.message || e);
    throw e;
  }
}

export async function confirmOrder(payload) {
  const { shipFee } = store.quoteOrder();
  return chargeThen(shipFee, 'Shinedy · דמי משלוח נוסף', 'ship', (paid) => store.confirmOrder(payload, { paid }));
}

export async function confirmExchange() {
  const { shipFee } = store.quoteExchange();
  return chargeThen(shipFee, 'Shinedy · דמי איסוף נוסף', 'ship', (paid) => store.confirmExchange({ paid }));
}

/** Purchase paid with the saved card (or fully with credits). */
export async function purchaseWithSavedCard(payload) {
  const { toPay, product } = store.quotePurchase(payload);
  if (toPay > 0 && !store.getMutableState().currentUserId && isDbEnabled) {
    throw httpError('רכישה כאורחת עוברת דרך דף התשלום', 400);
  }
  return chargeThen(toPay, `Shinedy · רכישת ${product.name}`, 'purchase', (paid) =>
    store.purchaseItem(payload, { paid: paid && { ...paid, card: store.savedCard() } }),
  );
}

/** First month for a customer who already has a saved card. */
export async function subscribeWithSavedCard(planId) {
  const st = store.getMutableState();
  if (st.subscribed && st.planId) return store.changePlan(planId);
  const plan = store.planPrice(planId);
  return chargeThen(plan.price, `Shinedy · מנוי ${plan.name}`, 'subscription', (paid) =>
    store.subscribe(plan.id, { paid }),
  );
}

/**
 * Tries to collect every charge the customer owes (monthly fees, fees recorded while
 * the card was failing). Never throws for a declined card; it marks the charge instead.
 */
export async function collectOutstanding() {
  const mode = gatewayMode();
  if (mode === 'off') return { paid: 0, failed: 0 };
  const result = { paid: 0, failed: 0 };
  for (const charge of store.collectibleCharges()) {
    if (mode === 'hyp' && !store.savedCard()) break;
    try {
      const paid = await chargeSavedCard(Number(charge.amount), `Shinedy · ${charge.description || 'חיוב'}`, charge.id);
      store.markChargePaid(charge.id, paid);
      result.paid += 1;
    } catch (e) {
      if (!e.ccode) break;
      store.markChargeFailed(charge.id, e.message);
      result.failed += 1;
    }
  }
  for (const charge of store.chargesToRefund()) {
    const ok = charge.transId.startsWith('SIM-') || (await hyp.cancelTransaction(charge.transId));
    store.markChargeRefunded(charge.id, ok);
  }
  return result;
}

/**
 * After cancel/freeze/resume/return cancellation: collect what's owed and refund what
 * was voided, without ever blocking the action itself.
 */
export async function settleAfterAction(result) {
  const st = store.getMutableState();
  const owed = store.collectibleCharges().length;
  let failed = 0;
  try {
    ({ failed } = await collectOutstanding());
  } catch (e) {
    console.error('settleAfterAction:', e?.message || e);
  }
  const unpaid = owed && (failed || (gatewayMode() === 'hyp' && !store.savedCard()));
  if (unpaid && st.flash) st.flash += ' · התשלום לא נגבה מהכרטיס, יש לעדכן כרטיס באזור האישי';
  const extra = result?.endSubscription ? { endSubscription: result.endSubscription } : {};
  return { ...store.getSnapshot(), ...extra };
}

function sanitizePurchase(raw = {}) {
  const pick = (obj, keys) =>
    Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, String(obj[k]).slice(0, 200)]));
  return {
    productId: String(raw.productId || raw.pid || ''),
    serial: raw.serial ? String(raw.serial) : null,
    creditToUse: Number(raw.creditToUse) || 0,
    recipient: raw.recipient ? String(raw.recipient).slice(0, 80) : '',
    address: pick(raw.address, ['street', 'houseNo', 'apt', 'city', 'zip', 'notes']),
    saveAddress: Boolean(raw.saveAddress),
    buyer: raw.buyer ? pick(raw.buyer, ['name', 'phone', 'email']) : null,
  };
}

/**
 * Opens a Hyp payment page for a subscription, a purchase, or a card update.
 * Runs inside the caller's request session. Returns { url } to redirect to,
 * or a snapshot with `paymentCompleted` when nothing had to be paid.
 */
export async function startCheckout(body = {}) {
  const mode = gatewayMode();
  if (mode === 'off') throw httpError('התשלום אינו זמין כרגע', 503);
  const st = store.getMutableState();
  const userId = st.currentUserId || null;
  const isStaff = st.currentUserRole === 'admin' || st.currentUserRole === 'warehouse';
  if (isStaff) throw httpError('חשבון ניהול לא יכול לבצע תשלום', 403);
  const kind = String(body.kind || '');
  let amount = 0;
  let info = '';
  let intent = {};

  if (kind === 'subscription') {
    if (!userId && isDbEnabled) throw httpError('יש להתחבר כדי להצטרף', 401);
    const plan = store.planPrice(body.planId);
    if (st.subscribed && st.planId) {
      return { ...store.changePlan(plan.id), paymentCompleted: true };
    }
    amount = plan.price;
    info = `Shinedy · מנוי ${plan.name} · חודש ראשון`;
    intent = { planId: plan.id };
  } else if (kind === 'purchase') {
    const purchase = sanitizePurchase(body.purchase);
    const quote = store.quotePurchase(purchase);
    if (quote.toPay <= 0) {
      return { ...store.purchaseItem(purchase, { paid: null }), paymentCompleted: true };
    }
    amount = quote.toPay;
    info = `Shinedy · רכישת ${quote.product.name}`;
    intent = { purchase, saveCard: Boolean(userId && body.saveCard !== false) };
  } else if (kind === 'card') {
    if (!userId && isDbEnabled) throw httpError('יש להתחבר כדי לעדכן כרטיס', 401);
    info = 'Shinedy · שמירת כרטיס לחיובים';
  } else {
    throw httpError('סוג תשלום לא מוכר');
  }

  const id = newPaymentId();
  if (mode === 'simulated') {
    const paid = simulatedPaid();
    const card = { token: `SIM${Date.now()}`, tokef: '3012', last4: '4242', holder: st.currentUserName };
    applyIntent(kind, intent, paid, card);
    return { ...store.getSnapshot(), paymentCompleted: true, paymentKind: kind };
  }

  const contact = userId
    ? store.billingContact()
    : (() => {
        const buyer = intent.purchase?.buyer || {};
        const [firstName, ...rest] = String(buyer.name || '').trim().split(/\s+/);
        return {
          firstName,
          lastName: rest.join(' '),
          email: buyer.email,
          cell: buyer.phone,
          street: [intent.purchase?.address?.street, intent.purchase?.address?.houseNo].filter(Boolean).join(' '),
          city: intent.purchase?.address?.city,
        };
      })();
  const url = await hyp.createPaymentPage({
    amount,
    order: id,
    info,
    client: contact,
    verifyOnly: kind === 'card',
  });
  await db.insertPayment({
    id,
    user_id: userId,
    kind,
    method: 'page',
    amount: kind === 'card' ? 0 : amount,
    status: 'pending',
    intent,
  });
  return { url, paymentId: id };
}

function applyIntent(kind, intent, paid, card) {
  if (kind === 'subscription') {
    const st = store.getMutableState();
    if (st.subscribed && st.planId) throw httpError('המנוי כבר פעיל, לא נדרש תשלום נוסף');
    if (card) store.setCardFromGateway(card);
    return store.subscribe(intent.planId, { paid });
  }
  if (kind === 'purchase') {
    if (card && intent.saveCard) store.setCardFromGateway(card);
    return store.purchaseItem(intent.purchase, { paid: { ...paid, card } });
  }
  if (kind === 'card') {
    if (!card) throw httpError('לא התקבל אישור לשמירת הכרטיס. נסי שוב', 402);
    store.setCardFromGateway(card);
    return null;
  }
  throw httpError('סוג תשלום לא מוכר');
}

const SUCCESS_MESSAGES = {
  subscription: 'התשלום התקבל והמנוי הופעל ✓',
  purchase: 'התשלום התקבל והרכישה הושלמה ✓',
  card: 'הכרטיס נשמר ✓',
};

/**
 * Handles the browser's return from the Hyp payment page. Verifies the signature
 * with Hyp, saves the card token, and applies the subscription/purchase exactly once.
 */
export async function completeCheckout(rawQuery) {
  if (gatewayMode() !== 'hyp') throw httpError('התשלום אינו זמין כרגע', 503);
  const query = String(rawQuery || '').replace(/^\?/, '');
  const params = Object.fromEntries(new URLSearchParams(query));
  const id = String(params.Order || '');
  if (!id.startsWith('PAY-')) throw httpError('תשלום לא מזוהה', 404);
  const row = await db.getPayment(id);
  if (!row) throw httpError('תשלום לא מזוהה', 404);
  const done = (ok, message, extra = {}) => ({ ok, kind: row.kind, message, ...extra });

  if (row.status === 'applied') return done(true, SUCCESS_MESSAGES[row.kind]);
  if (row.status === 'failed') return done(false, row.error || 'התשלום לא הושלם');
  if (row.status !== 'pending') return done(true, 'התשלום בטיפול. רענני את העמוד בעוד רגע', { processing: true });

  const okCodes = row.kind === 'card' ? ['0', '600'] : ['0'];
  if (!okCodes.includes(String(params.CCode))) {
    const message = hyp.declineMessage(params.CCode);
    if (await db.claimPayment(id, 'pending', 'failed')) {
      await db.updatePayment(id, { error: message, result: { CCode: params.CCode, Id: params.Id } });
    }
    return done(false, message);
  }
  if (!(await db.claimPayment(id, 'pending', 'processing'))) {
    return done(true, 'התשלום בטיפול. רענני את העמוד בעוד רגע', { processing: true });
  }

  const fail = async (message, { voidTrans = false } = {}) => {
    const voided = voidTrans ? await hyp.cancelTransaction(params.Id) : false;
    const full = voidTrans
      ? `${message}${voided ? ' · החיוב בוטל' : ' · נחזיר את הכסף ונעדכן אותך'}`
      : message;
    await db.updatePayment(id, {
      status: 'failed',
      error: full,
      provider_trans_id: params.Id || null,
      result: { CCode: params.CCode, Id: params.Id, voided },
    });
    return done(false, full);
  };

  if (!(await hyp.verifyRedirect(query))) return fail('לא הצלחנו לאמת את התשלום מול חברת הסליקה');
  if (row.kind !== 'card' && Math.abs(Number(params.Amount) - Number(row.amount)) > 0.009) {
    return fail('סכום התשלום אינו תואם להזמנה', { voidTrans: true });
  }

  const token = await hyp.fetchToken(params.Id);
  const card = token
    ? {
        ...token,
        last4: params.L4digit || token.token.slice(-4),
        holder: [params.ClientName, params.ClientLName].filter(Boolean).join(' '),
        holderId: params.UserId,
      }
    : null;
  const paid = { transId: params.Id, method: 'page' };

  try {
    const apply = () => applyIntent(row.kind, row.intent || {}, paid, card);
    if (row.user_id) {
      await actAsCustomer(row.user_id, async () => {
        apply();
        if (row.kind === 'card') await collectOutstanding();
      });
    } else {
      await actAsGuest(apply);
    }
  } catch (e) {
    console.error('apply payment failed:', id, e?.message || e);
    return fail(e?.message || 'לא הצלחנו להשלים את הפעולה', { voidTrans: row.kind !== 'card' });
  }

  await db.updatePayment(id, {
    status: 'applied',
    provider_trans_id: params.Id || null,
    result: {
      CCode: params.CCode,
      Id: params.Id,
      ACode: params.ACode,
      Amount: params.Amount,
      L4digit: params.L4digit,
      Brand: params.Brand,
      tokenSaved: Boolean(card),
    },
  });
  return done(true, SUCCESS_MESSAGES[row.kind]);
}

/** Daily run: bill every subscriber whose month started and retry failed charges. */
export async function runBilling({ limit = 25 } = {}) {
  if (gatewayMode() !== 'hyp' || !isDbEnabled) return { processed: 0, skipped: 'gateway off' };
  const candidates = await db.listBillingCandidates();
  const now = Date.now();
  const due = candidates.filter((row) => {
    const charges = Array.isArray(row.address?.charges) ? row.address.charges : [];
    if (charges.some((c) => c.status === 'לגבייה' || c.status === 'להחזר')) return true;
    if (row.suspended_at) return false;
    const subs = charges.filter((c) => c.kind === 'subscription').map((c) => Date.parse(c.periodStart));
    const last = subs.length ? Math.max(...subs) : Date.parse(row.address?.billingStart || '');
    return Number.isNaN(last) || last + 30 * 86400000 <= now;
  });
  const summary = { candidates: candidates.length, due: due.length, processed: 0, paid: 0, failed: 0, errors: 0 };
  for (const row of due.slice(0, limit)) {
    try {
      const r = await actAsCustomer(row.id, async () => {
        store.accrueSubscriptionCharges();
        return collectOutstanding();
      });
      summary.processed += 1;
      summary.paid += r.paid;
      summary.failed += r.failed;
    } catch (e) {
      summary.errors += 1;
      console.error('billing run:', row.id, e?.message || e);
    }
  }
  return summary;
}

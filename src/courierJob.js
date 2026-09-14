/** What the courier company should do for this order. */
export const COURIER_JOBS = {
  delivery: 'delivery',
  pickup: 'pickup',
  both: 'both',
};

const LABELS = {
  delivery: 'משלוח',
  pickup: 'איסוף',
  both: 'משלוח ואיסוף',
};

/** Lowest plan: no POD. The two higher plans require a delivery signature. */
const NO_POD_PLANS = new Set(['silver', 'essentials']);
const POD_PLANS = new Set(['combined', 'signature', 'gold', 'prestige']);

export function planRequiresDeliverySignature(planId) {
  if (!planId) return false;
  if (NO_POD_PLANS.has(planId)) return false;
  if (POD_PLANS.has(planId)) return true;
  return false;
}

export function deliverySignatureLabel(required) {
  return required ? 'חתימת מסירה נדרשת' : 'ללא חתימת מסירה';
}

export function courierJobLabel(job) {
  return LABELS[job] || '';
}

function courierMeta(order) {
  return (order?.newItems || []).find((x) => x && x.kind === 'courier-job') || null;
}

export function resolveCourierJob(order) {
  if (!order) return null;
  const stored = order.courierJob || courierMeta(order)?.job;
  if (stored && LABELS[stored]) return stored;
  return inferCourierJob(order);
}

export function inferCourierJob(order) {
  const type = order?.type || 'הזמנה';
  const returns = order?.returnItems || order?.returns || [];
  const items = order?.items || [];
  if (type === 'החזרה' || (!items.length && returns.length)) return COURIER_JOBS.pickup;
  if (type === 'רכישה' || type === 'מכירה' || type === 'הזמנה ראשונה') return COURIER_JOBS.delivery;
  if (type === 'החלפה' || returns.length) return COURIER_JOBS.both;
  return COURIER_JOBS.delivery;
}

export function resolveDeliverySignature(order, planId) {
  if (typeof order?.deliverySignatureRequired === 'boolean') return order.deliverySignatureRequired;
  const meta = courierMeta(order);
  if (typeof meta?.deliverySignatureRequired === 'boolean') return meta.deliverySignatureRequired;
  return planRequiresDeliverySignature(planId || order?.planId);
}

export function attachCourierJob(order, job, extras = {}) {
  const resolved = job || inferCourierJob(order);
  const rest = (order.newItems || []).filter((x) => !x || x.kind !== 'courier-job');
  const planId = extras.planId ?? order.planId ?? null;
  const needsDelivery = resolved === COURIER_JOBS.delivery || resolved === COURIER_JOBS.both;
  const signatureRequired = needsDelivery
    ? Boolean(
        extras.deliverySignatureRequired ??
          resolveDeliverySignature(order, planId),
      )
    : false;
  order.planId = planId;
  order.courierJob = resolved;
  order.courierJobLabel = courierJobLabel(resolved);
  order.needsDelivery = needsDelivery;
  order.needsPickup = resolved === COURIER_JOBS.pickup || resolved === COURIER_JOBS.both;
  order.deliverySignatureRequired = signatureRequired;
  order.deliverySignatureLabel = deliverySignatureLabel(signatureRequired);
  order.newItems = [
    ...rest,
    { kind: 'courier-job', job: resolved, planId, deliverySignatureRequired: signatureRequired },
  ];
  return order;
}

/** Payload to send to the courier company (Cheetah / HFD / etc). */
export function courierDispatchPayload(order) {
  const job = resolveCourierJob(order);
  const signatureRequired = resolveDeliverySignature(order);
  return {
    job,
    jobLabel: courierJobLabel(job),
    needsDelivery: job === COURIER_JOBS.delivery || job === COURIER_JOBS.both,
    needsPickup: job === COURIER_JOBS.pickup || job === COURIER_JOBS.both,
    deliverySignatureRequired: signatureRequired,
    deliverySignatureLabel: deliverySignatureLabel(signatureRequired),
    planId: order.planId || null,
  };
}

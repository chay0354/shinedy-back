/** Card charges stay off until PAYMENTS_ON=1. PAYMENTS_OFF=0 also turns them back on. */
export function paymentsAreOff() {
  const on = String(process.env.PAYMENTS_ON || '').trim().toLowerCase();
  if (on === '1' || on === 'true' || on === 'yes') return false;
  const off = String(process.env.PAYMENTS_OFF || '').trim().toLowerCase();
  if (off === '0' || off === 'false' || off === 'no') return false;
  return true;
}

import { createHmac } from 'node:crypto';

const TTL_MS = 2 * 60 * 60 * 1000;

function secret() {
  return (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.RESEND_API_KEY ||
    'shinedy-signup-proof'
  );
}

export function signupVerifyProof(kind, dest) {
  const exp = Date.now() + TTL_MS;
  const sig = createHmac('sha256', secret()).update(`${kind}:${dest}:${exp}`).digest('hex');
  return `${exp}.${sig}`;
}

export function signupProofValid(kind, dest, token) {
  const [expRaw, sig] = String(token || '').split('.');
  const exp = Number(expRaw);
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = createHmac('sha256', secret()).update(`${kind}:${dest}:${exp}`).digest('hex');
  return expected === sig;
}

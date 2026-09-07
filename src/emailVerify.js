import { createHash, randomInt } from 'node:crypto';
import { sendVerificationCodeEmail } from './mail.js';
import { rememberQaOtp } from './qaOtp.js';
import { getSupabase } from './supabase.js';
import { emailKey } from './contactIdentity.js';

const TTL_MS = 15 * 60 * 1000;
const RESEND_GAP_MS = 45 * 1000;
const codes = new Map();

function hashCode(email, code) {
  return createHash('sha256').update(`${emailKey(email)}:${code}`).digest('hex');
}

export function verificationEnabled() {
  return Boolean(process.env.RESEND_API_KEY);
}

async function findUserIdByEmail(email) {
  const admin = getSupabase();
  if (!admin) return null;
  const { data, error } = await admin.from('profiles').select('id').ilike('email', email).limit(1);
  if (error) {
    console.error('email otp lookup:', error.message || error);
    return null;
  }
  return data?.[0]?.id || null;
}

async function persistOtp(email, row) {
  codes.set(email, row);
  const admin = getSupabase();
  const userId = await findUserIdByEmail(email);
  if (!admin || !userId) return;
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) {
    console.error('email otp read user:', error.message || error);
    return;
  }
  const meta = data?.user?.user_metadata || {};
  const { error: saveError } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: { ...meta, email_otp: row },
  });
  if (saveError) console.error('email otp save:', saveError.message || saveError);
}

async function readOtp(email) {
  if (codes.has(email)) return codes.get(email);
  const admin = getSupabase();
  const userId = await findUserIdByEmail(email);
  if (!admin || !userId) return null;
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) {
    console.error('email otp load:', error.message || error);
    return null;
  }
  const row = data?.user?.user_metadata?.email_otp;
  if (row) codes.set(email, row);
  return row || null;
}

async function clearOtp(email) {
  codes.delete(email);
  const admin = getSupabase();
  const userId = await findUserIdByEmail(email);
  if (!admin || !userId) return;
  const { data } = await admin.auth.admin.getUserById(userId);
  const meta = { ...(data?.user?.user_metadata || {}) };
  delete meta.email_otp;
  await admin.auth.admin.updateUserById(userId, { user_metadata: meta }).catch(() => {});
}

export async function issueEmailCode(email) {
  const key = emailKey(email);
  if (!key) {
    const err = new Error('חסר אימייל');
    err.status = 400;
    throw err;
  }
  const prev = await readOtp(key);
  if (prev && Date.now() - prev.sentAt < RESEND_GAP_MS) {
    const err = new Error('יש להמתין רגע לפני שליחת קוד חדש');
    err.status = 429;
    throw err;
  }
  const code = String(randomInt(100000, 1000000));
  const row = {
    hash: hashCode(key, code),
    expiresAt: Date.now() + TTL_MS,
    sentAt: Date.now(),
    attempts: 0,
  };
  rememberQaOtp('email', key, code);
  await sendVerificationCodeEmail(key, code);
  await persistOtp(key, row);
  return { email: key };
}

export async function checkEmailCode(email, rawCode) {
  const key = emailKey(email);
  const code = String(rawCode || '').replace(/\D/g, '');
  const row = await readOtp(key);
  if (!row || Date.now() > row.expiresAt) {
    await clearOtp(key);
    const err = new Error('הקוד פג תוקף. שלחי קוד חדש');
    err.status = 400;
    throw err;
  }
  row.attempts += 1;
  if (row.attempts > 8) {
    await clearOtp(key);
    const err = new Error('יותר מדי ניסיונות. שלחי קוד חדש');
    err.status = 400;
    throw err;
  }
  if (row.hash !== hashCode(key, code)) {
    await persistOtp(key, row);
    const err = new Error('הקוד שגוי');
    err.status = 400;
    throw err;
  }
  await clearOtp(key);
  return key;
}

import { createHash, randomInt } from 'node:crypto';
import { sendVerificationCodeEmail } from './mail.js';
import { rememberQaOtp } from './qaOtp.js';

const TTL_MS = 15 * 60 * 1000;
const RESEND_GAP_MS = 45 * 1000;
const codes = new Map();

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function hashCode(email, code) {
  return createHash('sha256').update(`${emailKey(email)}:${code}`).digest('hex');
}

export function verificationEnabled() {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function issueEmailCode(email) {
  const key = emailKey(email);
  if (!key) {
    const err = new Error('חסר אימייל');
    err.status = 400;
    throw err;
  }
  const prev = codes.get(key);
  if (prev && Date.now() - prev.sentAt < RESEND_GAP_MS) {
    const err = new Error('יש להמתין רגע לפני שליחת קוד חדש');
    err.status = 429;
    throw err;
  }
  const code = String(randomInt(100000, 1000000));
  codes.set(key, {
    hash: hashCode(key, code),
    expiresAt: Date.now() + TTL_MS,
    sentAt: Date.now(),
    attempts: 0,
  });
  rememberQaOtp('email', key, code);
  await sendVerificationCodeEmail(key, code);
  return { email: key };
}

export function checkEmailCode(email, rawCode) {
  const key = emailKey(email);
  const code = String(rawCode || '').replace(/\D/g, '');
  const row = codes.get(key);
  if (!row || Date.now() > row.expiresAt) {
    codes.delete(key);
    const err = new Error('הקוד פג תוקף. שלחי קוד חדש');
    err.status = 400;
    throw err;
  }
  row.attempts += 1;
  if (row.attempts > 8) {
    codes.delete(key);
    const err = new Error('יותר מדי ניסיונות. שלחי קוד חדש');
    err.status = 400;
    throw err;
  }
  if (row.hash !== hashCode(key, code)) {
    const err = new Error('הקוד שגוי');
    err.status = 400;
    throw err;
  }
  codes.delete(key);
  return key;
}

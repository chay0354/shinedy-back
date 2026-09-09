import { createHash, randomInt } from 'node:crypto';
import { phoneKey, toE164 } from './contactIdentity.js';
import { rememberQaOtp } from './qaOtp.js';
import { clearPendingOtp, loadPendingOtp, savePendingOtp } from './pendingOtp.js';

const TTL_MS = 15 * 60 * 1000;
const RESEND_GAP_MS = 45 * 1000;

function accountAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return { sid, token };
}

function senderConfig() {
  return {
    from: process.env.TWILIO_FROM_NUMBER?.trim() || '',
    messagingSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || '',
    verifySid: process.env.TWILIO_VERIFY_SID?.trim() || '',
  };
}

export function smsVerificationEnabled() {
  const auth = accountAuth();
  if (!auth) return false;
  const { from, messagingSid, verifySid } = senderConfig();
  return Boolean(from || messagingSid || verifySid);
}

function hashCode(phone, code) {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

function twilioHeaders(auth) {
  return {
    Authorization: `Basic ${Buffer.from(`${auth.sid}:${auth.token}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function destinationCandidates(phone) {
  const e164 = toE164(phone);
  if (!e164) return [];
  const key = phoneKey(phone);
  const trialLegacy = key ? `+9720${key}` : '';
  return [...new Set([e164, trialLegacy].filter(Boolean))];
}

async function postTwilioMessage(auth, params) {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${auth.sid}/Messages.json`, {
    method: 'POST',
    headers: twilioHeaders(auth),
    body: new URLSearchParams(params),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function sendViaSender(to, code) {
  const auth = accountAuth();
  const { from, messagingSid } = senderConfig();
  if (!auth || (!from && !messagingSid)) {
    const err = new Error('שליחת SMS אינה מוגדרת בשרת');
    err.status = 503;
    throw err;
  }
  const dests = destinationCandidates(to);
  let last = null;
  for (const dest of dests) {
    const params = {
      To: dest,
      Body: `הקוד לאימות Shinedy הוא ${code}. תקף ל-15 דקות.`,
    };
    if (messagingSid) params.MessagingServiceSid = messagingSid;
    else params.From = from;
    last = await postTwilioMessage(auth, params);
    if (last.ok) return;
    console.error('Twilio SMS error:', last.status, last.data, dest);
    const unverified = last.data?.code === 21608 || /unverified/i.test(String(last.data?.message || ''));
    if (!unverified) break;
  }
  const err = new Error(
    last?.data?.message || 'שליחת ה-SMS נכשלה. בדקי את המספר, A2P, וחשבון Twilio.',
  );
  err.status = 502;
  throw err;
}

async function sendViaVerify(to) {
  const auth = accountAuth();
  const { verifySid } = senderConfig();
  if (!auth || !verifySid) {
    const err = new Error('שליחת SMS אינה מוגדרת בשרת');
    err.status = 503;
    throw err;
  }
  let last = null;
  for (const dest of destinationCandidates(to)) {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${verifySid}/Verifications`, {
      method: 'POST',
      headers: twilioHeaders(auth),
      body: new URLSearchParams({ To: dest, Channel: 'sms' }),
    });
    last = { ok: r.ok, data: await r.json().catch(() => ({})) };
    if (last.ok) return;
    console.error('Twilio verify error:', r.status, last.data, dest);
    const unverified = last.data?.code === 21608 || /unverified/i.test(String(last.data?.message || ''));
    if (!unverified) break;
  }
  const err = new Error(last?.data?.message || 'שליחת ה-SMS נכשלה.');
  err.status = 502;
  throw err;
}

function usesOwnSender() {
  const { from, messagingSid } = senderConfig();
  return Boolean(from || messagingSid);
}

export async function issueSmsCode(phone) {
  const to = toE164(phone);
  if (!to) {
    const err = new Error('יש למלא מספר נייד תקין, למשל 0500000000');
    err.status = 400;
    throw err;
  }
  const prev = await loadPendingOtp('sms', to);
  if (prev && Date.now() - prev.sentAt < RESEND_GAP_MS) {
    const err = new Error('יש להמתין רגע לפני שליחת קוד חדש');
    err.status = 429;
    throw err;
  }

  if (usesOwnSender()) {
    const code = String(randomInt(100000, 1000000));
    await savePendingOtp('sms', to, {
      hash: hashCode(to, code),
      expiresAt: Date.now() + TTL_MS,
      sentAt: Date.now(),
      attempts: 0,
    });
    rememberQaOtp('sms', to, code);
    await sendViaSender(to, code);
  } else {
    await sendViaVerify(to);
  }
  return { phone: to };
}

export async function checkSmsCode(phone, rawCode) {
  const to = toE164(phone);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!to || code.length < 4) {
    const err = new Error('הקוד שגוי');
    err.status = 400;
    throw err;
  }

  if (usesOwnSender()) {
    const row = await loadPendingOtp('sms', to);
    if (!row || Date.now() > row.expiresAt) {
      await clearPendingOtp('sms', to);
      const err = new Error('הקוד פג תוקף. שלחי קוד חדש');
      err.status = 400;
      throw err;
    }
    row.attempts += 1;
    if (row.attempts > 8) {
      await clearPendingOtp('sms', to);
      const err = new Error('יותר מדי ניסיונות. שלחי קוד חדש');
      err.status = 400;
      throw err;
    }
    if (row.hash !== hashCode(to, code)) {
      await savePendingOtp('sms', to, row);
      const err = new Error('הקוד שגוי');
      err.status = 400;
      throw err;
    }
    await clearPendingOtp('sms', to);
    return to;
  }

  const auth = accountAuth();
  const { verifySid } = senderConfig();
  const r = await fetch(`https://verify.twilio.com/v2/Services/${verifySid}/VerificationCheck`, {
    method: 'POST',
    headers: twilioHeaders(auth),
    body: new URLSearchParams({ To: to, Code: code }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.status !== 'approved') {
    const err = new Error(data?.message || 'הקוד שגוי או שפג תוקפו');
    err.status = 400;
    throw err;
  }
  return to;
}

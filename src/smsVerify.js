import { createHash, randomInt } from 'node:crypto';
import { toE164 } from './contactIdentity.js';
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
  const messagingSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || '';
  const alpha =
    process.env.TWILIO_ALPHA_SENDER?.trim() || (messagingSid ? 'Shinedy' : '');
  return {
    from: process.env.TWILIO_FROM_NUMBER?.trim() || '',
    messagingSid,
    verifySid: process.env.TWILIO_VERIFY_SID?.trim() || '',
    alpha,
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

function destination(phone) {
  return toE164(phone);
}

async function readMessage(auth, messageSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  if (!accountSid || !messageSid) return null;
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`,
    { headers: { Authorization: twilioHeaders(auth).Authorization } },
  );
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function waitForOutcome(auth, messageSid) {
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    last = await readMessage(auth, messageSid);
    if (!last) return null;
    if (last.status === 'delivered' || last.status === 'failed' || last.status === 'undelivered') {
      return last;
    }
  }
  return last;
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

function deliveryError(status) {
  const err = new Error(
    status === 'undelivered' || status === 'failed'
      ? 'ההודעה לא הגיעה לטלפון. בדקי את המספר, או חפשי הודעה מהשולח Shinedy.'
      : 'שליחת ה-SMS נכשלה. בדקי את המספר ונסי שוב.',
  );
  err.status = 502;
  return err;
}

async function sendViaSender(to, code) {
  const auth = accountAuth();
  const { from, messagingSid, alpha } = senderConfig();
  if (!auth || (!from && !messagingSid && !alpha)) {
    const err = new Error('שליחת SMS אינה מוגדרת בשרת');
    err.status = 503;
    throw err;
  }
  const dest = destination(to);
  if (!dest) {
    const err = new Error('יש למלא מספר נייד תקין, למשל 0500000000');
    err.status = 400;
    throw err;
  }
  const body = `הקוד לאימות Shinedy הוא ${code}. תקף ל-15 דקות.`;
  const attempts = [];
  if (alpha) {
    const named = { To: dest, Body: body, From: alpha };
    if (messagingSid) named.MessagingServiceSid = messagingSid;
    attempts.push(named);
  }
  if (from || messagingSid) {
    const fallback = { To: dest, Body: body };
    if (messagingSid) fallback.MessagingServiceSid = messagingSid;
    else fallback.From = from;
    attempts.push(fallback);
  }

  let last = null;
  for (const params of attempts) {
    last = await postTwilioMessage(auth, params);
    if (!last.ok) {
      console.error('Twilio SMS error:', last.status, last.data?.code, last.data?.message);
      continue;
    }
    const outcome = await waitForOutcome(auth, last.data?.sid);
    if (outcome?.status === 'failed' || outcome?.status === 'undelivered') {
      console.error('Twilio SMS not delivered:', outcome.status, outcome.error_code, outcome.error_message);
      last = { ok: false, status: 502, data: outcome };
      continue;
    }
    return;
  }
  throw deliveryError(last?.data?.status);
}

async function sendViaVerify(to) {
  const auth = accountAuth();
  const { verifySid } = senderConfig();
  if (!auth || !verifySid) {
    const err = new Error('שליחת SMS אינה מוגדרת בשרת');
    err.status = 503;
    throw err;
  }
  const dest = destination(to);
  const r = await fetch(`https://verify.twilio.com/v2/Services/${verifySid}/Verifications`, {
    method: 'POST',
    headers: twilioHeaders(auth),
    body: new URLSearchParams({ To: dest, Channel: 'sms' }),
  });
  const last = { ok: r.ok, data: await r.json().catch(() => ({})) };
  if (!last.ok) {
    console.error('Twilio verify error:', r.status, last.data?.code, last.data?.message);
  } else {
    return;
  }
  const err = new Error('שליחת ה-SMS נכשלה.');
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
    const row = {
      hash: hashCode(to, code),
      expiresAt: Date.now() + TTL_MS,
      sentAt: Date.now(),
      attempts: 0,
    };
    rememberQaOtp('sms', to, code);
    await sendViaSender(to, code);
    await savePendingOtp('sms', to, row);
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
    const err = new Error('הקוד שגוי או שפג תוקפו');
    err.status = 400;
    throw err;
  }
  return to;
}

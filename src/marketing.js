import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDbEnabled, getSupabase } from './supabase.js';
import { sendResendEmail } from './mail.js';
import { resolveUserRole } from './db.js';
import { sendCustomerSms } from './smsVerify.js';
import { phoneKey } from './contactIdentity.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanEmail(raw) {
  return String(raw || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim()
    .toLowerCase();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function siteUrl() {
  return String(process.env.SITE_URL || 'https://www.shinedy.co')
    .replace(/\/+$/, '')
    .replace('://www.', '://');
}

function signingKey() {
  return (
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'shinedy-dev-unsubscribe'
  );
}

function signature(userId, length) {
  return createHmac('sha256', signingKey()).update(`unsub:${userId}`).digest('base64url').slice(0, length);
}

export function unsubscribeToken(userId) {
  const id = Buffer.from(String(userId).replace(/-/g, ''), 'hex').toString('base64url');
  return `${id}${signature(userId, 6)}`;
}

const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SHORT_CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/;

function randomShortCode() {
  const bytes = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  return code;
}

async function ensureUnsubCode(userId) {
  if (!UUID_RE.test(String(userId || ''))) throw httpError('לקוחה לא נמצאה', 404);
  const client = getSupabase();
  if (!client) throw httpError('המערכת לא מוכנה כרגע. נסי שוב בעוד רגע', 503);
  const { data, error } = await client.from('profiles').select('address').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw httpError('לקוחה לא נמצאה', 404);
  const current = String(data.address?.unsub || '');
  if (SHORT_CODE_RE.test(current)) return current;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomShortCode();
    const taken = await userIdFromShortCode(code);
    if (taken) continue;
    const address = { ...(data.address || {}), unsub: code };
    const { error: upErr } = await client.from('profiles').update({ address }).eq('id', userId);
    if (upErr) throw upErr;
    return code;
  }
  throw httpError('לא הצלחנו ליצור קישור הסרה. נסי שוב', 503);
}

async function userIdFromShortCode(code) {
  const client = getSupabase();
  if (!client) return null;
  const { data, error } = await client.from('profiles').select('id').eq('address->>unsub', code).limit(1);
  if (error) throw error;
  return data?.[0]?.id || null;
}

export async function unsubscribeUrl(userId) {
  const code = await ensureUnsubCode(userId);
  return `${siteUrl()}/u/${code}`;
}

function userIdFromToken(token) {
  const raw = String(token || '').trim();
  let idPart = '';
  let sig = '';
  let sigLength = 0;
  if (raw.includes('.')) {
    [idPart, sig] = raw.split('.');
    sigLength = 10;
  } else if (raw.length === 28) {
    idPart = raw.slice(0, 22);
    sig = raw.slice(22);
    sigLength = 6;
  }
  if (!idPart || !sig) return null;
  const hex = Buffer.from(idPart, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_RE.test(userId)) return null;
  const want = Buffer.from(signature(userId, sigLength));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return userId;
}

export function isOptedIn(row) {
  return Boolean(row?.notices_accepted_at) && !row?.address?.marketingOptOutAt;
}

const SMS_OPT_OUT_WORDS = new Set(['הסר', 'הסרה', 'stop', 'stopall', 'unsubscribe']);

export function isSmsOptOut(body) {
  const text = String(body || '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
    .toLowerCase();
  return SMS_OPT_OUT_WORDS.has(text);
}

export function smsWithOptOut(body) {
  const text = String(body || '').trim();
  return `${text}\nלהסרה השיבי הסר`.trim();
}

export async function unsubscribeBySms(from, body) {
  if (!isSmsOptOut(body)) return '';
  const key = phoneKey(from);
  if (!key) return 'המספר הזה לא רשום לדיוור.';
  const client = getSupabase();
  if (!client) throw httpError('המערכת לא מוכנה כרגע. נסי שוב בעוד רגע', 503);
  const { data, error } = await client
    .from('profiles')
    .select('id, email, phone, role, notices_accepted_at, address');
  if (error) throw error;
  const matches = (data || []).filter(
    (row) => phoneKey(row.phone) === key && resolveUserRole(row) === 'customer',
  );
  if (!matches.length) return 'המספר הזה לא רשום לדיוור.';
  const { runQueued } = await import('./session.js');
  await runQueued(async () => {
    for (const row of matches) {
      if (!row.address?.marketingOptOutAt) await setMarketingOptIn(row.id, false);
    }
  });
  return 'הוסרת מרשימת הדיוור של Shinedy.';
}

export function textToHtml(body, url) {
  const paras = String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const link = escapeHtml(url);
  return `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#262626;direction:rtl;text-align:right;max-width:560px;margin:0 auto;padding:24px">
  ${paras}
  <p style="font-size:12px;margin:24px 0 0"><a href="${link}" style="color:#75706a">להסרה</a></p>
</div>`.trim();
}

async function marketingRows() {
  if (!isDbEnabled) return [];
  const client = getSupabase();
  if (!client) return [];
  const { data, error } = await client
    .from('profiles')
    .select('id, email, phone, full_name, role, notices_accepted_at, address, created_at')
    .not('notices_accepted_at', 'is', null);
  if (error) throw error;
  return (data || []).filter((row) => resolveUserRole(row) === 'customer');
}

function rowView(row) {
  return {
    id: row.id,
    name: row.full_name || '',
    email: cleanEmail(row.email),
    phone: row.phone || '',
    joinedAt: row.created_at || null,
    optedInAt: row.notices_accepted_at || null,
    optedOutAt: row.address?.marketingOptOutAt || null,
  };
}

export async function marketingOverview() {
  const rows = await marketingRows();
  const list = rows.map(rowView);
  return {
    subscribed: list.filter((r) => !r.optedOutAt),
    unsubscribed: list.filter((r) => r.optedOutAt),
  };
}

export async function listMarketingRecipients() {
  const rows = await marketingRows();
  return rows.filter(isOptedIn).map(rowView);
}

export async function setMarketingOptIn(userId, optIn) {
  if (!UUID_RE.test(String(userId || ''))) throw httpError('לקוחה לא נמצאה', 404);
  const client = getSupabase();
  if (!client) throw httpError('המערכת לא מוכנה כרגע. נסי שוב בעוד רגע', 503);
  const { data, error } = await client
    .from('profiles')
    .select('address, notices_accepted_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw httpError('לקוחה לא נמצאה', 404);
  if (optIn && !data.notices_accepted_at) {
    throw httpError('הלקוחה לא אישרה דיוור בהרשמה, ולכן אי אפשר לצרף אותה לרשימה');
  }
  const address = { ...(data.address || {}) };
  if (optIn) delete address.marketingOptOutAt;
  else address.marketingOptOutAt = address.marketingOptOutAt || new Date().toISOString();
  const { error: upErr } = await client.from('profiles').update({ address }).eq('id', userId);
  if (upErr) throw upErr;
  return { optedIn: optIn };
}

export async function unsubscribeByToken(token) {
  const raw = String(token || '').trim();
  const userId = userIdFromToken(raw) || (SHORT_CODE_RE.test(raw) ? await userIdFromShortCode(raw) : null);
  if (!userId) throw httpError('הקישור להסרה אינו תקין');
  const { runQueued } = await import('./session.js');
  await runQueued(() => setMarketingOptIn(userId, false));
  return { ok: true };
}

export async function broadcastMarketing({ subject, body, email = true, sms = false }) {
  const subj = String(subject || '').trim();
  const text = String(body || '').trim();
  const viaEmail = Boolean(email);
  const viaSms = Boolean(sms);
  if (!viaEmail && !viaSms) throw httpError('יש לבחור מייל, SMS או את שניהם');
  if (viaEmail && subj.length < 2) throw httpError('יש להזין נושא למייל');
  if (text.length < 8) throw httpError('יש להזין תוכן להודעה');
  if (viaEmail && !process.env.RESEND_API_KEY) {
    throw httpError('שליחת מייל אינה מוגדרת בשרת (RESEND_API_KEY)', 503);
  }

  const recipients = await listMarketingRecipients();
  const result = {
    recipients: recipients.length,
    email: { sent: 0, failed: 0, skipped: 0 },
    sms: { sent: 0, failed: 0, skipped: 0 },
  };

  for (const r of recipients) {
    if (viaEmail) {
      if (!r.email) {
        result.email.skipped += 1;
      } else {
        try {
          const url = await unsubscribeUrl(r.id);
          await sendResendEmail({
            to: r.email,
            subject: subj,
            text: `${text}\n\nלהסרה: ${url}`,
            html: textToHtml(text, url),
          });
          result.email.sent += 1;
        } catch (e) {
          result.email.failed += 1;
          console.error('marketing email failed:', e.message || e);
        }
      }
    }
    if (viaSms) {
      if (!r.phone) {
        result.sms.skipped += 1;
      } else {
        const sent = await sendCustomerSms(r.phone, smsWithOptOut(text), { replyable: true });
        if (sent.ok) result.sms.sent += 1;
        else result.sms.failed += 1;
      }
    }
  }
  return result;
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDbEnabled, getSupabase } from './supabase.js';
import { sendResendEmail } from './mail.js';
import { resolveUserRole } from './db.js';
import { sendCustomerSms } from './smsVerify.js';

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
  return String(process.env.SITE_URL || 'https://www.shinedy.co').replace(/\/+$/, '');
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

function signature(userId) {
  return createHmac('sha256', signingKey()).update(`unsub:${userId}`).digest('base64url').slice(0, 10);
}

export function unsubscribeToken(userId) {
  const id = Buffer.from(String(userId).replace(/-/g, ''), 'hex').toString('base64url');
  return `${id}.${signature(userId)}`;
}

export function unsubscribeUrl(userId) {
  return `${siteUrl()}/u/${unsubscribeToken(userId)}`;
}

function userIdFromToken(token) {
  const [idPart, sig] = String(token || '').trim().split('.');
  if (!idPart || !sig) return null;
  const hex = Buffer.from(idPart, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_RE.test(userId)) return null;
  const want = Buffer.from(signature(userId));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return userId;
}

export function isOptedIn(row) {
  return Boolean(row?.notices_accepted_at) && !row?.address?.marketingOptOutAt;
}

export function smsWithOptOut(body, userId) {
  return `${String(body || '').trim()}\nלהסרה: ${unsubscribeUrl(userId)}`;
}

function textToHtml(body, userId) {
  const paras = String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const link = escapeHtml(unsubscribeUrl(userId));
  return `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#262626;direction:rtl;text-align:right;max-width:560px;margin:0 auto;padding:24px">
  ${paras}
  <hr style="border:none;border-top:1px solid #e7d8c9;margin:28px 0 16px"/>
  <p style="font-size:12px;color:#75706a;margin:0">קיבלת את ההודעה כי אישרת דיוור מ-Shinedy. <a href="${link}" style="color:#75706a">להסרה מרשימת הדיוור לחצי כאן</a></p>
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
  const userId = userIdFromToken(token);
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
          await sendResendEmail({
            to: r.email,
            subject: subj,
            text: `${text}\n\nלהסרה מרשימת הדיוור: ${unsubscribeUrl(r.id)}`,
            html: textToHtml(text, r.id),
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
        const sent = await sendCustomerSms(r.phone, smsWithOptOut(text, r.id));
        if (sent.ok) result.sms.sent += 1;
        else result.sms.failed += 1;
      }
    }
  }
  return result;
}

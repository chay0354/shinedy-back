import { isDbEnabled, getSupabase } from './supabase.js';
import { sendResendEmail } from './mail.js';
import { resolveUserRole } from './db.js';

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

function textToHtml(body) {
  const paras = String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#262626;direction:rtl;text-align:right;max-width:560px;margin:0 auto;padding:24px">
  ${paras}
  <hr style="border:none;border-top:1px solid #e7d8c9;margin:28px 0 16px"/>
  <p style="font-size:12px;color:#75706a;margin:0">קיבלת את ההודעה כי אישרת דיוור מ-Shinedy. להסרה מרשימת התפוצה פני ל-service@shinedy.co</p>
</div>`.trim();
}

export async function listMarketingRecipients() {
  if (!isDbEnabled) return [];
  const client = getSupabase();
  if (!client) return [];
  const { data, error } = await client
    .from('profiles')
    .select('id, email, full_name, role, notices_accepted_at')
    .not('notices_accepted_at', 'is', null);
  if (error) throw error;
  return (data || [])
    .filter((row) => resolveUserRole(row) === 'customer' && cleanEmail(row.email))
    .map((row) => ({
      id: row.id,
      email: cleanEmail(row.email),
      name: row.full_name || '',
    }));
}

export async function broadcastMarketing({ subject, body }) {
  const subj = String(subject || '').trim();
  const text = String(body || '').trim();
  if (subj.length < 2) {
    const err = new Error('יש להזין נושא להודעה');
    err.status = 400;
    throw err;
  }
  if (text.length < 8) {
    const err = new Error('יש להזין תוכן להודעה');
    err.status = 400;
    throw err;
  }
  if (!process.env.RESEND_API_KEY) {
    const err = new Error('שליחת מייל אינה מוגדרת בשרת (RESEND_API_KEY)');
    err.status = 503;
    throw err;
  }

  const recipients = await listMarketingRecipients();
  if (!recipients.length) {
    return { sent: 0, failed: 0, recipients: 0 };
  }

  const html = textToHtml(text);
  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const r of recipients) {
    try {
      await sendResendEmail({
        to: r.email,
        subject: subj,
        text,
        html,
      });
      sent += 1;
    } catch (e) {
      failed += 1;
      if (errors.length < 5) errors.push(`${r.email}: ${e.message || e}`);
      console.error('marketing broadcast:', r.email, e.message || e);
    }
  }

  return {
    sent,
    failed,
    recipients: recipients.length,
    errors: errors.length ? errors : undefined,
  };
}

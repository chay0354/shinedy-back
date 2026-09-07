const FALLBACK_FROM = process.env.RESEND_FROM || 'Shinedy <beth.t@example.com>';

function configuredFrom() {
  return String(process.env.CONTACT_FROM || process.env.RESEND_FROM || FALLBACK_FROM).trim();
}

function canSendFrom(from) {
  const value = String(from || '').toLowerCase();
  return Boolean(value) && !value.includes('@shinedy.co');
}

function fromCandidates() {
  const brand = configuredFrom();
  return [...new Set([FALLBACK_FROM, canSendFrom(brand) ? brand : null].filter(Boolean))];
}

function isDomainFailure(status, detail) {
  return status === 403 || /domain is not verified|not verified/i.test(detail);
}

async function postResendEmail(key, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const detail = await r.text().catch(() => '');
  return { ok: r.ok, status: r.status, detail };
}

export async function sendResendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    const err = new Error('שליחת המייל אינה מוגדרת בשרת');
    err.status = 503;
    throw err;
  }
  const body = {
    to: [to],
    reply_to: replyTo || undefined,
    subject,
    text,
    html: html || undefined,
  };
  const froms = fromCandidates();
  let last = null;
  for (const from of froms) {
    last = await postResendEmail(key, { ...body, from });
    if (last.ok) return;
    console.error('Resend error:', last.status, last.detail, from);
    if (!isDomainFailure(last.status, last.detail)) break;
  }
  const err = new Error(
    isDomainFailure(last?.status, last?.detail || '')
      ? 'שליחת המייל נכשלה. דומיין השולח עדיין לא מאומת ב-Resend.'
      : 'שליחת המייל נכשלה. נסי שוב בעוד רגע.',
  );
  err.status = 502;
  throw err;
}

export async function sendVerificationCodeEmail(email, code) {
  const text = `הקוד לאימות המייל ב-Shinedy הוא ${code}. הקוד תקף ל-15 דקות.`;
  await sendResendEmail({
    to: email,
    subject: `${code} — קוד אימות Shinedy`,
    text,
    html: `<p style="font-family:sans-serif;font-size:16px;direction:rtl;text-align:right">הקוד לאימות המייל ב-Shinedy:</p><p style="font-family:sans-serif;font-size:28px;letter-spacing:0.2em;direction:ltr;text-align:center"><strong>${code}</strong></p><p style="font-family:sans-serif;font-size:14px;color:#666;direction:rtl;text-align:right">הקוד תקף ל-15 דקות.</p>`,
  });
}

const DEFAULT_FROM = process.env.CONTACT_FROM || 'Shinedy <noreply@shinedy.co>';

export async function sendResendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    const err = new Error('שליחת המייל אינה מוגדרת בשרת');
    err.status = 503;
    throw err;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: DEFAULT_FROM,
      to: [to],
      reply_to: replyTo || undefined,
      subject,
      text,
      html: html || undefined,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('Resend error:', r.status, detail);
    const err = new Error('שליחת המייל נכשלה. בדקי שהדומיין מאומת ב-Resend.');
    err.status = 502;
    throw err;
  }
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

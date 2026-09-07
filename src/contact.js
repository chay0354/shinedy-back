const TO = process.env.CONTACT_EMAIL || 'service@shinedy.co';

export async function sendContact(body = {}) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const subject = String(body.subject || 'פנייה מהאתר').trim() || 'פנייה מהאתר';
  const message = String(body.message || '').trim();

  if (!name || !email || !message) {
    const err = new Error('יש למלא שם, אימייל והודעה');
    err.status = 400;
    throw err;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('כתובת האימייל אינה תקינה');
    err.status = 400;
    throw err;
  }

  const text = `שם: ${name}\nאימייל: ${email}\nנושא: ${subject}\n\n${message}`;

  if (process.env.RESEND_API_KEY) {
    const { sendResendEmail } = await import('./mail.js');
    await sendResendEmail({
      to: TO,
      replyTo: email,
      subject: `פנייה מהאתר: ${subject}`,
      text,
    });
    return { ok: true };
  }

  const r = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(TO)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name,
      email,
      _subject: `פנייה מהאתר: ${subject}`,
      message: text,
    }),
  });
  if (!r.ok) {
    throw new Error('שליחת המייל נכשלה. אפשר לכתוב ישירות אל service@shinedy.co');
  }
  return { ok: true };
}

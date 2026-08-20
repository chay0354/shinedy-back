export function validIsraeliId(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 9) return false;
  const s = digits.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = Number(s[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 128);
  }
  return String(req.socket?.remoteAddress || '').slice(0, 128);
}

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

export function parseSignupLegal(body = {}) {
  const nationalId = String(body.nationalId || '').replace(/\D/g, '');
  if (!validIsraeliId(nationalId)) fail('מספר תעודת הזהות אינו תקין');
  if (!body.termsAccepted || !body.privacyAccepted) {
    fail('יש לאשר את התקנון ואת מדיניות הפרטיות');
  }
  if (!body.noticesAccepted) fail('יש לאשר קבלת הודעות תפעוליות על המנוי');

  const signatureData = String(body.signatureData || '');
  if (!signatureData.startsWith('data:image/') || signatureData.length < 4000) {
    fail('יש לחתום בשדה החתימה');
  }
  if (signatureData.length > 800_000) fail('החתימה גדולה מדי');

  const idDocumentUrl = String(body.idDocumentUrl || '');
  const okDoc =
    idDocumentUrl.startsWith('data:image/') || idDocumentUrl.startsWith('data:application/pdf');
  if (!okDoc || idDocumentUrl.length < 80) {
    fail('יש להעלות צילום או סריקה של תעודת הזהות');
  }
  if (idDocumentUrl.length > 6_000_000) fail('קובץ תעודת הזהות גדול מדי');

  const now = new Date().toISOString();
  return {
    nationalId,
    signatureData,
    idDocumentUrl,
    signatureCompleted: true,
    termsAcceptedAt: now,
    privacyAcceptedAt: now,
    noticesAcceptedAt: now,
  };
}

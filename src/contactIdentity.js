export function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

export function toE164(phone) {
  const key = phoneKey(phone);
  if (!key) return '';
  return `+972${key}`;
}

export function phoneKey(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export function emailsMatch(a, b) {
  const left = emailKey(a);
  const right = emailKey(b);
  return Boolean(left && right && left === right);
}

export function phonesMatch(a, b) {
  const left = phoneKey(a);
  const right = phoneKey(b);
  return Boolean(left && right && left === right);
}

export function signupConflictError(field) {
  const err = new Error(
    field === 'phone'
      ? 'כבר קיים חשבון עם מספר הטלפון הזה'
      : 'כבר קיים חשבון עם האימייל הזה',
  );
  err.status = 409;
  err.field = field;
  return err;
}

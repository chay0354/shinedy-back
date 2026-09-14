const EXACT = {
  'Product not found': 'התכשיט לא נמצא',
  'Order not found': 'ההזמנה לא נמצאה',
  'Invalid field': 'שדה לא תקין',
  'Invalid status': 'סטטוס לא תקין',
  'Invalid JSON in request body': 'הבקשה אינה תקינה',
  'Database not configured': 'המערכת לא מוכנה כרגע. נסי שוב בעוד רגע',
  'Database mode required': 'המערכת לא מוכנה כרגע. נסי שוב בעוד רגע',
  'Database mode required for registration': 'ההרשמה לא זמינה כרגע. נסי שוב בעוד רגע',
  'Supabase not configured': 'המערכת לא מוכנה כרגע. נסי שוב בעוד רגע',
  'Auth client not configured': 'ההתחברות לא זמינה כרגע. נסי שוב בעוד רגע',
  'Invalid login credentials': 'אימייל או סיסמה שגויים',
  'Email not confirmed': 'יש לאמת את כתובת האימייל לפני ההתחברות',
  'User already registered': 'האימייל כבר רשום במערכת',
};

const PATTERNS = [
  [/invalid login credentials/i, 'אימייל או סיסמה שגויים'],
  [/email not confirmed/i, 'יש לאמת את כתובת האימייל לפני ההתחברות'],
  [/already (been )?registered|user already exists|already exists/i, 'האימייל כבר רשום במערכת'],
  [/unable to validate email|invalid (email )?format/i, 'יש למלא אימייל תקין, למשל name@email.com'],
  [/password should be at least|password is too short/i, 'הסיסמה קצרה מדי'],
  [/email rate limit|too many requests|for security purposes/i, 'יותר מדי ניסיונות. יש להמתין רגע ולנסות שוב'],
  [/jwt expired|session.*expired/i, 'פג תוקף החיבור. התחברי שוב'],
  [/product not found/i, 'התכשיט לא נמצא'],
  [/order not found/i, 'ההזמנה לא נמצאה'],
  [/invalid (json|field|status)/i, 'הבקשה אינה תקינה'],
  [/not found/i, 'הפריט המבוקש לא נמצא'],
  [/unauthorized|not authenticated|invalid jwt/i, 'יש להתחבר מחדש'],
  [/forbidden|not allowed/i, 'אין הרשאה לפעולה הזו'],
  [/duplicate key|unique constraint/i, 'הפרט הזה כבר קיים במערכת'],
];

export function heError(raw, fallback = 'משהו לא עבד. נסי שוב') {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  if (/[\u0590-\u05FF]/.test(text) && !/[A-Za-z]{4,}/.test(text)) return text;
  if (EXACT[text]) return EXACT[text];
  for (const [re, he] of PATTERNS) {
    if (re.test(text)) return he;
  }
  if (/[A-Za-z]{4,}/.test(text)) return fallback;
  return text;
}

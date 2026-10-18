import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const DEFAULT_MEMBERSHIP_TERMS = [
  'החלפות ללא הגבלה',
  'משלוח דו-חודשי כלול. משלוח החלפה נוסף ₪65',
  'ביטול אחרי ניצול המשלוח, החזרה ₪65',
  'אין תקרת תכשיטים. הבחירה לפי נקודות בלבד',
];

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'membership-terms.json');

export function loadMembershipTerms() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    const lines = Array.isArray(raw) ? raw.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (lines.length) return lines;
  } catch {
    /* first run */
  }
  return DEFAULT_MEMBERSHIP_TERMS.slice();
}

export function saveMembershipTerms(lines) {
  const clean = (lines || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!clean.length) {
    const err = new Error('יש להשאיר לפחות תנאי אחד');
    err.status = 400;
    throw err;
  }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

import { getSupabase, isDbEnabled } from './supabase.js';
import { resolveUserRole } from './db.js';
import { ID_BUCKET, isDataUrl, storagePathFromRef } from './idVault.js';
import { sendCustomerSms } from './smsVerify.js';
import { getSetting, setSetting } from './settings.js';
import { isOptedIn, smsWithOptOut } from './marketing.js';

export const BIRTHDAY_SMS =
  'מזל טוב מ-Shinedy! החודש יום ההולדת שלך, ומחכה לך הטבת יום הולדת. לפרטים היכנסי לחשבון או כתבי ל-service@shinedy.co';

export async function getBirthdayText() {
  return String(await getSetting('birthdaySms', BIRTHDAY_SMS));
}

export async function saveBirthdayText(raw) {
  const text = String(raw || '').trim();
  if (text.length < 8) {
    const err = new Error('יש לכתוב הודעה של לפחות כמה מילים');
    err.status = 400;
    throw err;
  }
  if (text.length > 600) {
    const err = new Error('ההודעה ארוכה מדי');
    err.status = 400;
    throw err;
  }
  await setSetting('birthdaySms', text === BIRTHDAY_SMS ? '' : text);
  return text;
}

const OCR_LIMIT = 12

export function israelToday(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export function birthDateFromText(text, now = new Date()) {
  const raw = String(text || '');
  const yearNow = now.getFullYear();
  const found = [];
  const patterns = [
    /(?:^|[^\d])(\d{1,2})[./\-\s]+(\d{1,2})[./\-\s]+(\d{4})(?!\d)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(raw))) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      if (year < yearNow - 100 || year > yearNow - 16) continue;
      const dt = new Date(Date.UTC(year, month - 1, day));
      if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) continue;
      found.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  if (!found.length) return null;
  found.sort();
  return found[0];
}

function dataUrlBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > 5_000_000) return null;
  return { mime, buf };
}

function textFromPdf(buf) {
  const raw = buf.toString('latin1');
  const bits = [];
  const re = /\(([^()\\]{4,40})\)/g;
  let match;
  while ((match = re.exec(raw))) bits.push(match[1]);
  return bits.join('\n');
}

let ocrWorker = null;

async function textFromImage(buf) {
  if (!ocrWorker) {
    const { createWorker } = await import('tesseract.js');
    ocrWorker = await createWorker('eng');
    await ocrWorker.setParameters({ tessedit_char_whitelist: '0123456789./- ' });
  }
  const { data } = await ocrWorker.recognize(buf);
  return data?.text || '';
}

async function closeOcr() {
  if (!ocrWorker) return;
  const worker = ocrWorker;
  ocrWorker = null;
  await worker.terminate().catch(() => {});
}

async function readBirthDateFromBuffer(mime, buf) {
  const text = mime === 'application/pdf' ? textFromPdf(buf) : await textFromImage(buf);
  return birthDateFromText(text);
}

export async function readBirthDateFromDataUrl(dataUrl) {
  const parsed = dataUrlBuffer(dataUrl);
  if (!parsed) return null;
  if (parsed.mime === 'application/pdf') return readBirthDateFromBuffer(parsed.mime, parsed.buf);
  if (!parsed.mime.startsWith('image/')) return null;
  return readBirthDateFromBuffer(parsed.mime, parsed.buf);
}

async function downloadId(ref) {
  if (isDataUrl(ref)) return dataUrlBuffer(ref);
  const path = storagePathFromRef(ref);
  if (!path) return null;
  const admin = getSupabase();
  if (!admin) return null;
  const { data, error } = await admin.storage.from(ID_BUCKET).download(path);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  const ext = path.split('.').pop()?.toLowerCase();
  const mime = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { mime, buf };
}

async function saveAddress(userId, address) {
  const client = getSupabase();
  const { error } = await client.from('profiles').update({ address }).eq('id', userId);
  if (error) throw error;
}

export async function captureBirthDate(userId, dataUrl) {
  if (!isDbEnabled || !userId || !dataUrl) return null;
  const birthDate = await readBirthDateFromDataUrl(dataUrl);
  if (!birthDate) return null;
  const client = getSupabase();
  const { data, error } = await client.from('profiles').select('address').eq('id', userId).maybeSingle();
  if (error) throw error;
  const address = { ...(data?.address || {}) };
  if (address.birthDate === birthDate) return birthDate;
  address.birthDate = birthDate;
  await saveAddress(userId, address);
  return birthDate;
}

export async function runBirthdaySms(now = new Date()) {
  const summary = { month: 0, year: 0, dated: 0, recognized: 0, sent: 0, failed: 0, skipped: 0 };
  if (!isDbEnabled) return { ...summary, skipped: 'db off' };
  const today = israelToday(now);
  summary.month = today.month;
  summary.year = today.year;
  const client = getSupabase();
  const { data, error } = await client
    .from('profiles')
    .select('id, phone, email, role, address, id_document_url, notices_accepted_at');
  if (error) throw error;
  const rows = (data || []).filter((row) => resolveUserRole(row) === 'customer');
  const message = await getBirthdayText();
  let ocrUsed = 0;
  try {
    for (const row of rows) {
      const address = { ...(row.address || {}) };
      let birthDate = typeof address.birthDate === 'string' ? address.birthDate : '';
      if (!birthDate && row.id_document_url && ocrUsed < OCR_LIMIT) {
        ocrUsed += 1;
        try {
          const file = await downloadId(row.id_document_url);
          if (file) {
            const found = await readBirthDateFromBuffer(file.mime, file.buf);
            if (found) {
              birthDate = found;
              address.birthDate = found;
              await saveAddress(row.id, address);
              summary.recognized += 1;
            }
          }
        } catch (ocrErr) {
          console.error('birthday ocr:', ocrErr?.message || ocrErr);
        }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) continue;
      summary.dated += 1;
      const month = Number(birthDate.slice(5, 7));
      if (month !== today.month) continue;
      if (Number(address.birthdaySmsYear) === today.year || !isOptedIn(row)) {
        summary.skipped += 1;
        continue;
      }
      const result = await sendCustomerSms(row.phone, smsWithOptOut(message), { replyable: true });
      if (!result.ok) {
        summary.failed += 1;
        continue;
      }
      address.birthdaySmsYear = today.year;
      await saveAddress(row.id, address);
      summary.sent += 1;
    }
  } finally {
    await closeOcr();
  }
  return summary;
}

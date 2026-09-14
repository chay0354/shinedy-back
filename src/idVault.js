import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSupabase } from './supabase.js';

export const ID_BUCKET = 'id-documents';
const PATH_PREFIX = 'idocs:';
const ENC_PREFIX = 'enc:v1:';
const MAX_BYTES = 5_000_000;
const SIGNED_SECONDS = 60;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

function keyBytes() {
  const raw =
    process.env.ID_ENCRYPT_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'shinedy-dev-id-key';
  return createHash('sha256').update(String(raw)).digest();
}

export function encryptSecret(plain) {
  const text = String(plain || '').trim();
  if (!text) return null;
  if (text.startsWith(ENC_PREFIX)) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (!text.startsWith(ENC_PREFIX)) return text;
  try {
    const [ivB64, tagB64, dataB64] = text.slice(ENC_PREFIX.length).split('.');
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskNationalId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 4) return '••••';
  return `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function isStoredIdPath(value) {
  return String(value || '').startsWith(PATH_PREFIX);
}

export function isDataUrl(value) {
  return /^data:(image\/|application\/pdf)/i.test(String(value || ''));
}

export function hasIdDocument(value) {
  const text = String(value || '');
  return isStoredIdPath(text) || isDataUrl(text);
}

export function storagePathFromRef(value) {
  const text = String(value || '');
  if (text.startsWith(PATH_PREFIX)) return text.slice(PATH_PREFIX.length);
  return '';
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return null;
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { mime, buf };
}

function extForMime(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

export async function ensureIdVault() {
  const admin = getSupabase();
  if (!admin) return false;
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = (buckets || []).some((b) => b.id === ID_BUCKET || b.name === ID_BUCKET);
  if (exists) return true;
  const { error } = await admin.storage.createBucket(ID_BUCKET, {
    public: false,
    fileSizeLimit: MAX_BYTES,
    allowedMimeTypes: [...ALLOWED_MIME],
  });
  if (error && !/already exists|duplicate/i.test(error.message || '')) {
    console.error('id vault bucket:', error.message);
    return false;
  }
  return true;
}

export async function uploadIdDocument(userId, dataUrl) {
  if (isStoredIdPath(dataUrl)) return String(dataUrl);
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    const err = new Error('יש להעלות צילום או סריקה תקינים של תעודת הזהות');
    err.status = 400;
    throw err;
  }
  const admin = getSupabase();
  if (!admin) {
    const err = new Error('לא ניתן לשמור את תעודת הזהות כרגע');
    err.status = 503;
    throw err;
  }
  await ensureIdVault();
  const path = `${userId}/${randomUUID()}.${extForMime(parsed.mime)}`;
  const { error } = await admin.storage.from(ID_BUCKET).upload(path, parsed.buf, {
    contentType: parsed.mime,
    upsert: false,
  });
  if (error) {
    console.error('id document upload:', error.message);
    const err = new Error('שמירת תעודת הזהות נכשלה. נסי שוב');
    err.status = 502;
    throw err;
  }
  return `${PATH_PREFIX}${path}`;
}

export async function prepareProfileWrite(userId, patch = {}) {
  const next = { ...patch };
  if (next.national_id != null) {
    next.national_id = encryptSecret(decryptSecret(next.national_id) || next.national_id);
  }
  if (next.id_document_url && isDataUrl(next.id_document_url)) {
    next.id_document_url = await uploadIdDocument(userId, next.id_document_url);
  } else if (next.id_document_url && !isStoredIdPath(next.id_document_url)) {
    delete next.id_document_url;
  }
  return next;
}

export async function logIdAccess({ staffUserId, customerUserId, action }) {
  const admin = getSupabase();
  if (!admin) return;
  const { error } = await admin.from('id_document_access_log').insert({
    staff_user_id: staffUserId || null,
    customer_user_id: customerUserId || null,
    action: action || 'view',
  });
  if (error && !/does not exist|schema cache/i.test(error.message || '')) {
    console.error('id access log:', error.message);
  }
}

export async function staffOpenDocument(customerUserId, { staffUserId } = {}) {
  const admin = getSupabase();
  if (!admin) {
    const err = new Error('המערכת לא מוכנה כרגע. נסי שוב בעוד רגע');
    err.status = 503;
    throw err;
  }
  const { data, error } = await admin
    .from('profiles')
    .select('id_document_url')
    .eq('id', customerUserId)
    .maybeSingle();
  if (error) throw error;
  const ref = data?.id_document_url;
  if (isDataUrl(ref)) {
    const stored = await uploadIdDocument(customerUserId, ref);
    await admin.from('profiles').update({ id_document_url: stored }).eq('id', customerUserId);
    return staffOpenDocument(customerUserId, { staffUserId });
  }
  const path = storagePathFromRef(ref);
  if (!path) {
    const err = new Error('לא הועלתה תעודת זהות ללקוחה זו');
    err.status = 404;
    throw err;
  }
  const { data: signed, error: signErr } = await admin.storage
    .from(ID_BUCKET)
    .createSignedUrl(path, SIGNED_SECONDS);
  if (signErr || !signed?.signedUrl) {
    const err = new Error('לא ניתן לפתוח את הסריקה כרגע');
    err.status = 502;
    throw err;
  }
  await logIdAccess({ staffUserId, customerUserId, action: 'view' });
  return { url: signed.signedUrl, expiresIn: SIGNED_SECONDS };
}

export async function migrateLegacyIdDocuments() {
  const admin = getSupabase();
  if (!admin) return;
  const { data, error } = await admin
    .from('profiles')
    .select('id, id_document_url, national_id');
  if (error) {
    console.error('id vault migrate list:', error.message);
    return;
  }
  for (const row of data || []) {
    const patch = {};
    if (isDataUrl(row.id_document_url)) {
      try {
        patch.id_document_url = await uploadIdDocument(row.id, row.id_document_url);
      } catch (e) {
        console.error('id vault migrate file:', row.id, e.message);
      }
    }
    if (row.national_id && !String(row.national_id).startsWith(ENC_PREFIX)) {
      patch.national_id = encryptSecret(row.national_id);
    }
    if (!Object.keys(patch).length) continue;
    const { error: upErr } = await admin.from('profiles').update(patch).eq('id', row.id);
    if (upErr) console.error('id vault migrate save:', row.id, upErr.message);
  }
}

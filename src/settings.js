import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getSupabase, isDbEnabled } from './supabase.js';

const BUCKET = 'app-settings';
const OBJECT = 'settings.json';
const LOCAL_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'settings.json');
const CACHE_MS = 30_000;

let cache = null;
let cachedAt = 0;

async function ensureBucket(admin) {
  const { data: buckets } = await admin.storage.listBuckets();
  if ((buckets || []).some((b) => b.id === BUCKET || b.name === BUCKET)) return;
  const { error } = await admin.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
}

async function readAll() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  let next = {};
  const admin = isDbEnabled ? getSupabase() : null;
  if (admin) {
    const { data, error } = await admin.storage.from(BUCKET).download(OBJECT);
    if (!error && data) {
      try {
        next = JSON.parse(await data.text()) || {};
      } catch {
        next = {};
      }
    }
  } else {
    try {
      next = JSON.parse(readFileSync(LOCAL_FILE, 'utf8')) || {};
    } catch {
      next = {};
    }
  }
  cache = next;
  cachedAt = Date.now();
  return next;
}

async function writeAll(all) {
  const admin = isDbEnabled ? getSupabase() : null;
  if (admin) {
    await ensureBucket(admin);
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(OBJECT, Buffer.from(JSON.stringify(all, null, 2)), {
        contentType: 'application/json',
        upsert: true,
      });
    if (error) {
      const err = new Error('שמירת ההגדרה נכשלה. נסי שוב');
      err.status = 502;
      throw err;
    }
  } else {
    mkdirSync(dirname(LOCAL_FILE), { recursive: true });
    writeFileSync(LOCAL_FILE, JSON.stringify(all, null, 2));
  }
  cache = all;
  cachedAt = Date.now();
}

export async function getSetting(key, fallback) {
  const all = await readAll();
  const value = all[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

export async function setSetting(key, value) {
  const all = { ...(await readAll()) };
  if (value === undefined || value === null || value === '') delete all[key];
  else all[key] = value;
  await writeAll(all);
  return value;
}

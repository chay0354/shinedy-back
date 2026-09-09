import { getSupabase } from './supabase.js';

const mem = new Map();

function rowKey(channel, dest) {
  return `${channel}:${dest}`;
}

export async function savePendingOtp(channel, dest, row) {
  const key = rowKey(channel, dest);
  mem.set(key, row);
  const admin = getSupabase();
  if (!admin) return;
  const { error } = await admin.from('pending_otps').upsert({
    dest: key,
    channel,
    hash: row.hash,
    expires_at: new Date(row.expiresAt).toISOString(),
    sent_at: new Date(row.sentAt).toISOString(),
    attempts: row.attempts || 0,
  });
  if (error) console.error('pending otp save:', error.message || error);
}

export async function loadPendingOtp(channel, dest) {
  const key = rowKey(channel, dest);
  if (mem.has(key)) return mem.get(key);
  const admin = getSupabase();
  if (!admin) return null;
  const { data, error } = await admin.from('pending_otps').select('*').eq('dest', key).limit(1);
  if (error) {
    console.error('pending otp load:', error.message || error);
    return null;
  }
  const row = data?.[0];
  if (!row) return null;
  const mapped = {
    hash: row.hash,
    expiresAt: new Date(row.expires_at).getTime(),
    sentAt: new Date(row.sent_at).getTime(),
    attempts: row.attempts || 0,
  };
  mem.set(key, mapped);
  return mapped;
}

export async function clearPendingOtp(channel, dest) {
  const key = rowKey(channel, dest);
  mem.delete(key);
  const admin = getSupabase();
  if (!admin) return;
  await admin.from('pending_otps').delete().eq('dest', key).then(({ error }) => {
    if (error) console.error('pending otp clear:', error.message || error);
  });
}

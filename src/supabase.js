import { createAdminClient, verifyCredentials, resolveEnv } from '@supabase/server/core';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL?.trim();
const legacyServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

function hasNewSecretKey() {
  if (secretKey) return true;
  const { data } = resolveEnv();
  return Boolean(data?.secretKeys?.default);
}

export const isDbEnabled = Boolean(
  process.env.USE_DATABASE === 'true' &&
    url?.startsWith('https://') &&
    (hasNewSecretKey() || legacyServiceKey || secretKey),
);

let adminClient = null;

export function getSupabase() {
  if (!isDbEnabled) return null;
  if (adminClient) return adminClient;

  const adminKey = secretKey || legacyServiceKey;

  if (hasNewSecretKey()) {
    try {
      adminClient = createAdminClient({
        env: {
          url,
          secretKeys: secretKey ? { default: secretKey } : undefined,
        },
      });
      return adminClient;
    } catch (err) {
      console.error('createAdminClient failed:', err.message);
    }
  }

  if (adminKey) {
    adminClient = createClient(url, adminKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return adminClient;
}

export async function pingDatabase() {
  const client = getSupabase();
  if (!client) {
    return { ok: false, error: 'Database not configured (check SUPABASE_URL and SUPABASE_SECRET_KEY)' };
  }

  const { error } = await client.from('plans').select('id').limit(1);
  if (error) {
    return { ok: false, error: error.message, details: error.code || error.hint || null };
  }
  return { ok: true };
}

export async function getUserFromToken(token) {
  if (!isDbEnabled || !token) return null;

  const { data: auth, error } = await verifyCredentials(
    { token, apikey: null },
    { auth: 'user' },
  );

  if (!error && auth?.userClaims) {
    return {
      id: auth.userClaims.id,
      email: auth.userClaims.email,
      user_metadata: auth.userClaims.userMetadata ?? {},
      app_metadata: auth.userClaims.appMetadata ?? {},
    };
  }

  const client = getSupabase();
  if (!client) return null;

  const { data, error: legacyError } = await client.auth.getUser(token);
  if (legacyError || !data.user) return null;
  return data.user;
}

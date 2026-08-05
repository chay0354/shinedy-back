import dns from 'node:dns';
import { createAdminClient, verifyCredentials, resolveEnv } from '@supabase/server/core';
import { createClient } from '@supabase/supabase-js';

dns.setDefaultResultOrder('ipv4first');

const url = process.env.SUPABASE_URL?.trim();
const legacyServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const adminKey = secretKey || legacyServiceKey;

function hasNewSecretKey() {
  if (secretKey) return true;
  const { data } = resolveEnv();
  return Boolean(data?.secretKeys?.default);
}

export const isDbEnabled = Boolean(
  process.env.USE_DATABASE === 'true' &&
    url?.startsWith('https://') &&
    (hasNewSecretKey() || legacyServiceKey),
);

let adminClient = null;

function supabaseClientOptions() {
  return {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Connection: 'close' },
    },
  };
}

export function getSupabase() {
  if (!isDbEnabled) return null;
  if (adminClient) return adminClient;

  if (hasNewSecretKey()) {
    try {
      adminClient = createAdminClient({
        env: {
          url,
          secretKeys: secretKey ? { default: secretKey } : undefined,
        },
        supabaseOptions: supabaseClientOptions(),
      });
      return adminClient;
    } catch (err) {
      console.error('createAdminClient failed:', err.message);
    }
  }

  if (adminKey) {
    adminClient = createClient(url, adminKey, supabaseClientOptions());
  }

  return adminClient;
}

export async function pingDatabase() {
  const host = url ? new URL(url).hostname : null;

  if (!url?.startsWith('https://')) {
    return {
      ok: false,
      error: 'SUPABASE_URL must start with https://',
      host,
    };
  }

  if (!adminKey) {
    return {
      ok: false,
      error: 'Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY',
      host,
    };
  }

  try {
    const res = await fetch(`${url}/rest/v1/plans?select=id&limit=1`, {
      headers: {
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`,
        Connection: 'close',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        error: `HTTP ${res.status}`,
        details: body.slice(0, 300),
        host,
      };
    }

    return { ok: true, host };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      cause: e.cause?.message ?? null,
      code: e.cause?.code ?? null,
      host,
    };
  }
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

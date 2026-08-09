import dns from 'node:dns';
import { createAdminClient, createContextClient, verifyCredentials, resolveEnv } from '@supabase/server/core';
import { createClient } from '@supabase/supabase-js';

dns.setDefaultResultOrder('ipv4first');

const url = process.env.SUPABASE_URL?.trim();
const legacyServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

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
let authClient = null;

function supabaseClientOptions() {
  return {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Connection: 'close' },
    },
  };
}

const adminKey = secretKey || legacyServiceKey;

function publishableEnv() {
  if (!publishableKey) return undefined;
  return { url, publishableKeys: { default: publishableKey } };
}

export function getUserSupabase(token) {
  if (!isDbEnabled || !token) return null;
  try {
    return createContextClient({
      auth: { token },
      env: publishableEnv(),
    });
  } catch (err) {
    console.error('createContextClient failed:', err.message);
    return null;
  }
}

// Sign-in must never run on the admin singleton: it stores the user JWT on the
// client and every later write would then be evaluated against RLS.
export function getAuthClient() {
  if (!isDbEnabled || !url) return null;
  if (authClient) return authClient;
  const key = publishableKey || adminKey;
  if (!key) return null;
  authClient = createClient(url, key, supabaseClientOptions());
  return authClient;
}

export function getSupabase() {
  if (!isDbEnabled) return null;
  if (adminClient) return adminClient;

  // Prefer supabase-js with the secret key so PostgREST always bypasses RLS.
  // createAdminClient can fail to attach the secret in some Vercel env setups.
  if (adminKey) {
    adminClient = createClient(url, adminKey, supabaseClientOptions());
    return adminClient;
  }

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

  return adminClient;
}

export function getConfigStatus() {
  return {
    url: Boolean(url?.startsWith('https://')),
    adminKey: Boolean(adminKey),
    publishableKey: Boolean(publishableKey),
    authClient: Boolean(url && (publishableKey || adminKey)),
  };
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

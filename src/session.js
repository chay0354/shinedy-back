import { getUserFromToken, isDbEnabled } from './supabase.js';
import * as db from './db.js';
import * as store from './store.js';

let seedOrders = [];
let seedPouches = [];
let dbReady = false;

export async function initDbIfNeeded() {
  if (!isDbEnabled || dbReady) return;
  const result = await db.loadCatalogIntoState(store.getMutableState());
  seedOrders = result.seedOrders;
  seedPouches = result.seedPouches;
  dbReady = true;
}

async function hydrateForRequest(req, { auth = false, staff = false } = {}) {
  await initDbIfNeeded();
  if (!isDbEnabled) return null;

  if (staff) {
    store.clearUserSession();
    store.mergeOrders(seedOrders);
    store.mergePouches(seedPouches);
    return null;
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = await getUserFromToken(token);

  if (auth && isDbEnabled && !user) {
    const err = new Error('יש להתחבר');
    err.status = 401;
    throw err;
  }

  if (user) {
    const session = await db.loadUserSession(user.id, store.getMutableState());
    store.mergeOrders([...seedOrders, ...session.userOrders]);
    store.mergePouches([...seedPouches, ...session.userPouches]);
    return user;
  }

  store.clearUserSession();
  store.mergeOrders(seedOrders);
  store.mergePouches(seedPouches);
  return null;
}

async function persistAfterRequest(user, staff = false) {
  if (!isDbEnabled) return;

  if (staff) {
    const st = store.getMutableState();
    const currentSeedOrders = st.orders.filter((o) => !o.userId);
    const currentSeedPouches = st.returnPouches.filter((p) => !p.userId);
    seedOrders = currentSeedOrders;
    seedPouches = currentSeedPouches;
    await db.persistGlobalCatalog(st, seedOrders, seedPouches);
    return;
  }

    if (user) {
    const st = store.getMutableState();
    const userOrders = st.orders.filter((o) => o.userId === user.id);
    const userPouches = st.returnPouches.filter((p) => p.userId === user.id);
    const reg = st.registration;
    if (reg) {
      await db.updateRegistration(user.id, {
        registration_step: reg.step ?? 0,
        phone: reg.phone,
        phone_verified: reg.phoneVerified ?? false,
        email_verified: reg.emailVerified ?? false,
        id_document_url: reg.idDocumentUrl,
        signature_completed: reg.signatureCompleted ?? false,
        payment_method_added: reg.paymentMethodAdded ?? false,
      });
    }
    await db.persistUserSession(user.id, st, userOrders, userPouches);
  }
}

export async function withRequest(req, fn, opts = {}) {
  const user = await hydrateForRequest(req, opts);
  try {
    const result = fn();
    await persistAfterRequest(user, opts.staff);
    return result;
  } catch (e) {
    throw e;
  }
}

export async function registerUser({ email, password, fullName, phone }) {
  if (!isDbEnabled) {
    throw new Error('Database mode required for registration');
  }
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone },
  });
  if (error) throw error;

  await db.updateRegistration(data.user.id, {
    full_name: fullName,
    phone,
    email,
    registration_step: 1,
  });

  const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;

  return { user: data.user, session: signIn.session };
}

export async function loginUser({ email, password }) {
  if (!isDbEnabled) {
    return { session: null, snapshot: store.login() };
  }
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { user: data.user, session: data.session };
}

export async function updateRegistrationStep(userId, patch) {
  await db.updateRegistration(userId, patch);
}

export { isDbEnabled };

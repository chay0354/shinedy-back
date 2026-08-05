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

async function requireStaffAccess(req, staffRoles = ['admin']) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = await getUserFromToken(token);
  if (!user) {
    const err = new Error('יש להתחבר');
    err.status = 401;
    throw err;
  }
  const role = await db.getUserRole(user.id);
  if (!staffRoles.includes(role)) {
    const err = new Error('אין הרשאת ניהול');
    err.status = 403;
    throw err;
  }
  return user;
}

function rejectStaffFromCustomerRoute() {
  const st = store.getMutableState();
  if (st.currentUserRole === 'admin' || st.currentUserRole === 'warehouse') {
    const err = new Error('חשבון ניהול — אין גישה לאזור לקוחות');
    err.status = 403;
    throw err;
  }
}

async function hydrateForRequest(req, { auth = false, staff = false, staffRoles = ['admin'], customerOnly = false } = {}) {
  await initDbIfNeeded();
  if (!isDbEnabled) return null;

  if (staff) {
    await requireStaffAccess(req, staffRoles);
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
    if (customerOnly) {
      rejectStaffFromCustomerRoute();
    }
    return user;
  }

  store.clearUserSession();
  store.mergeOrders(seedOrders);
  store.mergePouches(seedPouches);
  return null;
}

async function persistAfterRequest(req, user, staff = false) {
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
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || null;
    const st = store.getMutableState();
    const userOrders = st.orders.filter((o) => o.userId === user.id);
    const userPouches = st.returnPouches.filter((p) => p.userId === user.id);
    const reg = st.registration;
    if (reg) {
      await db.updateRegistration(
        user.id,
        {
          registration_step: reg.step ?? 0,
          phone: reg.phone,
          phone_verified: reg.phoneVerified ?? false,
          email_verified: reg.emailVerified ?? false,
          id_document_url: reg.idDocumentUrl,
          signature_completed: reg.signatureCompleted ?? false,
          payment_method_added: reg.paymentMethodAdded ?? false,
        },
        token,
      );
    }
    await db.persistUserSession(user.id, st, userOrders, userPouches, token);
  }
}

export async function withRequest(req, fn, opts = {}) {
  const user = await hydrateForRequest(req, opts);
  try {
    const result = fn();
    await persistAfterRequest(req, user, opts.staff);
    return result;
  } catch (e) {
    throw e;
  }
}

export async function deleteAllUsers() {
  if (!isDbEnabled) {
    throw new Error('Database mode required');
  }
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase not configured');

  let deleted = 0;
  let page = 1;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    if (!data.users.length) break;

    for (const user of data.users) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
      if (delErr) throw delErr;
      deleted += 1;
    }

    if (data.users.length < 100) break;
    page += 1;
  }

  return { deleted };
}

export async function registerUser({ email, password, fullName }) {
  if (!isDbEnabled) {
    throw new Error('Database mode required for registration');
  }
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    const msg = error.message || '';
    if (msg.includes('already been registered') || msg.includes('already registered')) {
      const err = new Error('כבר קיים חשבון עם דוא״ל זה');
      err.status = 422;
      throw err;
    }
    throw error;
  }

  await db.ensureUserProfile(data.user.id, {
    full_name: fullName,
    email,
    registration_step: 7,
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
  await db.ensureAdminByEmail(data.user.id, email);
  return { user: data.user, session: data.session };
}

export async function updateRegistrationStep(userId, patch) {
  await db.updateRegistration(userId, patch);
}

export { isDbEnabled };

import { getUserFromToken, isDbEnabled } from './supabase.js';
import * as db from './db.js';
import * as store from './store.js';
import { signupConflictError } from './contactIdentity.js';
import { heError } from './heError.js';
import { ensureIdVault, migrateLegacyIdDocuments, uploadIdDocument } from './idVault.js';

function throwHe(error, status = 400, fallback) {
  const err = new Error(heError(error?.message || error, fallback));
  err.status = error?.status || status;
  throw err;
}

let seedOrders = [];
let seedPouches = [];
let dbReady = false;

export async function initDbIfNeeded() {
  if (!isDbEnabled || dbReady) return;
  await ensureIdVault().catch((e) => console.error('id vault init:', e?.message || e));
  await migrateLegacyIdDocuments().catch((e) => console.error('id vault migrate:', e?.message || e));
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
  return { user, role };
}

function rejectStaffFromCustomerRoute() {
  const st = store.getMutableState();
  if (st.currentUserRole === 'admin' || st.currentUserRole === 'warehouse') {
    const err = new Error('חשבון ניהול — אין גישה לאזור לקוחות');
    err.status = 403;
    throw err;
  }
}

function mergeById(existing, incoming) {
  return [...new Map([...existing, ...incoming].map((row) => [row.id, row])).values()];
}

async function refreshSeedFromDb() {
  const fresh = await db.refreshOpsIntoState(store.getMutableState());
  seedOrders = fresh.seedOrders;
  seedPouches = fresh.seedPouches;
}

async function hydrateForRequest(req, opts = {}) {
  const { auth = false, staff = false, staffRoles = ['admin'], customerOnly = false } = opts;
  await initDbIfNeeded();
  if (!isDbEnabled) return null;

  if (staff) {
    const { user: staffUser, role } = await requireStaffAccess(req, staffRoles);
    const orderId = req.params?.id;
    const haveOrder = orderId && store.getMutableState().orders?.some((o) => o.id === orderId);
    const targeted = (opts.persist === 'order' && haveOrder) || opts.persist === 'product';
    if (!targeted) {
      await refreshSeedFromDb();
    }
    store.clearUserSession();
    const st = store.getMutableState();
    st.currentUserId = staffUser.id;
    st.currentUserRole = role;
    st.currentUserName = staffUser.email || 'צוות';
    store.mergeOrders(seedOrders);
    store.mergePouches(seedPouches);
    if (!opts.skipStaffCustomers) {
      try {
        store.getMutableState().staffCustomers = await db.loadStaffCustomers(role);
      } catch (e) {
        console.error('loadStaffCustomers:', e?.message || e);
      }
    }
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
    let session;
    try {
      session = await db.loadUserSession(user.id, store.getMutableState());
    } catch (e) {
      console.error('loadUserSession:', e?.message || e);
      store.clearUserSession();
      store.mergeOrders(seedOrders);
      store.mergePouches(seedPouches);
      return null;
    }
    const role = store.getMutableState().currentUserRole;
    if (role === 'admin' || role === 'warehouse') {
      try {
        await refreshSeedFromDb();
        store.mergeOrders(seedOrders);
        store.mergePouches(seedPouches);
        store.getMutableState().staffCustomers = await db.loadStaffCustomers(role);
      } catch (e) {
        console.error('staff hydrate:', e?.message || e);
      }
    } else {
      store.mergeOrders([...seedOrders, ...session.userOrders]);
      store.mergePouches([...seedPouches, ...session.userPouches]);
    }
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

async function dropDeletedRows(st) {
  const orderIds = st.deletedOrderIds || [];
  const pouchIds = st.deletedPouchIds || [];
  if (!orderIds.length && !pouchIds.length) return;
  await db.deleteOrdersAndPouches(orderIds, pouchIds);
  seedOrders = seedOrders.filter((o) => !orderIds.includes(o.id));
  seedPouches = seedPouches.filter((p) => !pouchIds.includes(p.id));
  st.deletedOrderIds = [];
  st.deletedPouchIds = [];
}

async function persistAfterRequest(req, user, opts = {}) {
  if (!isDbEnabled) return;
  const staff = opts.staff;

  if (staff) {
    const st = store.getMutableState();
    seedOrders = st.orders;
    seedPouches = st.returnPouches;
    if (opts.persist === 'order') {
      const order = st.orders.find((o) => o.id === req.params?.id);
      await db.persistOrderAndUnits(st, order);
      return;
    }
    if (opts.persist === 'product') {
      const productId = typeof opts.productId === 'function' ? opts.productId(req, st) : req.params?.id;
      await db.persistProductAndUnits(st, productId);
      return;
    }
    await db.persistGlobalCatalog(st, seedOrders, seedPouches);
    return;
  }

  if (user) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || null;
    const st = store.getMutableState();
    await dropDeletedRows(st);
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
          signature_completed: reg.signatureCompleted ?? false,
          payment_method_added: reg.paymentMethodAdded ?? false,
          ...(reg.nationalId ? { national_id: reg.nationalId } : {}),
          terms_accepted_at: reg.termsAcceptedAt,
          privacy_accepted_at: reg.privacyAcceptedAt,
          notices_accepted_at: reg.noticesAcceptedAt,
          signup_ip: reg.signupIp,
        },
        token,
      );
    }
    await db.persistUserSession(user.id, st, userOrders, userPouches, token);
    seedOrders = mergeById(seedOrders, userOrders);
    seedPouches = mergeById(seedPouches, userPouches);
    return;
  }

  await persistGuestPurchases(store.getMutableState());
}

async function persistGuestPurchases(st) {
  const known = new Set(seedOrders.map((o) => o.id));
  const guestPurchases = st.orders.filter((o) => o.type === 'רכישה' && !o.userId && !known.has(o.id));
  if (!guestPurchases.length) return;
  seedOrders = [...seedOrders, ...guestPurchases];
  await db.persistGlobalCatalog(st, guestPurchases, []);
}

// The store is a module-level singleton, so hydrate -> act -> persist must run
// to completion before the next request loads a different user over it.
let requestQueue = Promise.resolve();

export async function withRequest(req, fn, opts = {}) {
  const run = requestQueue.then(async () => {
    const user = await hydrateForRequest(req, opts);
    const result = await fn();
    if (!opts.skipPersist) {
      try {
        await persistAfterRequest(req, user, opts);
      } catch (e) {
        console.error('persistAfterRequest:', e?.message || e);
      }
    }
    return result;
  });
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function enqueue(task) {
  const run = requestQueue.then(task);
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Loads one customer's account, runs `action`, and saves it. Must run inside the queue. */
async function actOnCustomerLocked(customerId, action) {
  await refreshSeedFromDb();
  const st = store.getMutableState();
  store.clearUserSession();
  const loaded = await db.loadUserSession(customerId, st);
  if (st.currentUserRole !== 'customer') {
    const err = new Error('הלקוחה לא נמצאה');
    err.status = 404;
    throw err;
  }
  store.mergeOrders([...seedOrders, ...loaded.userOrders]);
  store.mergePouches([...seedPouches, ...loaded.userPouches]);
  const result = await action();
  await dropDeletedRows(st);
  const userOrders = st.orders.filter((o) => o.userId === customerId);
  const userPouches = st.returnPouches.filter((p) => p.userId === customerId);
  await db.persistUserSession(customerId, st, userOrders, userPouches, null);
  seedOrders = mergeById(seedOrders, userOrders);
  seedPouches = mergeById(seedPouches, userPouches);
  return result;
}

/**
 * Lets an admin act on one customer's account (freeze, cancel, edit details) with the
 * same store rules the customer gets, then returns the admin's own view.
 */
export async function runForCustomer(req, customerId, action) {
  return enqueue(async () => {
    await initDbIfNeeded();
    if (!isDbEnabled) {
      const err = new Error('הפעולה זמינה רק כשהמערכת מחוברת למסד הנתונים');
      err.status = 503;
      throw err;
    }
    const { user: staffUser, role } = await requireStaffAccess(req, ['admin']);
    await actOnCustomerLocked(customerId, action);

    const st = store.getMutableState();
    store.clearUserSession();
    st.currentUserId = staffUser.id;
    st.currentUserRole = role;
    st.currentUserName = staffUser.email || 'צוות';
    store.mergeOrders(seedOrders);
    store.mergePouches(seedPouches);
    st.staffCustomers = await db.loadStaffCustomers(role);
    return store.getSnapshot();
  });
}

/** Server-initiated work on a customer's account (payment return, monthly billing). */
export async function actAsCustomer(customerId, action) {
  return enqueue(async () => {
    await initDbIfNeeded();
    if (!isDbEnabled) return action();
    try {
      return await actOnCustomerLocked(customerId, action);
    } finally {
      store.clearUserSession();
    }
  });
}

/** Server-initiated work with no customer loaded (a guest's paid purchase). */
export async function actAsGuest(action) {
  return enqueue(async () => {
    await initDbIfNeeded();
    if (!isDbEnabled) return action();
    await refreshSeedFromDb();
    store.clearUserSession();
    store.mergeOrders(seedOrders);
    store.mergePouches(seedPouches);
    const result = await action();
    await persistGuestPurchases(store.getMutableState());
    return result;
  });
}

export async function deleteAllUsers() {
  if (!isDbEnabled) {
    throw new Error('המערכת לא מוכנה כרגע. נסי שוב בעוד רגע');
  }
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  if (!supabase) throw new Error('המערכת לא מוכנה כרגע. נסי שוב בעוד רגע');

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

export async function registerUser({
  email,
  password,
  fullName,
  phone,
  address,
  nationalId,
  signatureData,
  idDocumentUrl,
  signatureCompleted,
  termsAcceptedAt,
  privacyAcceptedAt,
  noticesAcceptedAt,
  signupIp,
}) {
  if (!isDbEnabled) {
    throw new Error('ההרשמה לא זמינה כרגע. נסי שוב בעוד רגע');
  }
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  await db.assertUniqueContact({ email, phone });

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone: phone || '' },
  });
  if (error) {
    const msg = (error.message || '').toLowerCase();
    if (
      msg.includes('already been registered') ||
      msg.includes('already registered') ||
      msg.includes('user already exists') ||
      msg.includes('already exists')
    ) {
      throw signupConflictError('email');
    }
    if (msg.includes('unable to validate email') || msg.includes('invalid format')) {
      const err = new Error('יש למלא אימייל תקין, למשל name@email.com');
      err.status = 400;
      throw err;
    }
    throwHe(error);
  }

  const storedDoc = idDocumentUrl ? await uploadIdDocument(data.user.id, idDocumentUrl) : null;
  const legalPatch = {
    full_name: fullName,
    email,
    phone: phone || '',
    address: address || {},
    credits: 0,
    registration_step: 7,
    national_id: nationalId || null,
    id_document_url: storedDoc,
    signature_data: signatureData || null,
    signature_completed: signatureCompleted ?? false,
    terms_accepted_at: termsAcceptedAt || null,
    privacy_accepted_at: privacyAcceptedAt || null,
    notices_accepted_at: noticesAcceptedAt || null,
    signup_ip: signupIp || null,
  };

  try {
    await db.ensureUserProfile(data.user.id, legalPatch);
  } catch (profileErr) {
    // Trigger may already have created the row; don't fail registration for that.
    console.error('ensureUserProfile after register:', profileErr?.message || profileErr);
  }
  try {
    await db.saveSignupLegal(data.user.id, legalPatch);
  } catch (legalErr) {
    console.error('saveSignupLegal after register:', legalErr?.message || legalErr);
    throwHe(legalErr, 502, 'שמירת פרטי האימות נכשלה. נסי שוב');
  }

  const { getAuthClient } = await import('./supabase.js');
  const authClient = getAuthClient();
  if (!authClient) throw new Error('ההתחברות לא זמינה כרגע. נסי שוב בעוד רגע');
  const { data: signIn, error: signInError } = await authClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throwHe(signInError);

  return { user: data.user, session: signIn.session };
}

export async function loginUser({ email, password }) {
  if (!isDbEnabled) {
    return { session: null, snapshot: store.login() };
  }
  const { getAuthClient } = await import('./supabase.js');
  const authClient = getAuthClient();
  if (!authClient) throw new Error('ההתחברות לא זמינה כרגע. נסי שוב בעוד רגע');
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) throwHe(error, 401, 'אימייל או סיסמה שגויים');
  try {
    await db.ensureAdminByEmail(data.user.id, data.user.email || email);
  } catch (e) {
    console.error('ensureAdminByEmail:', e?.message || e);
  }
  return { user: data.user, session: data.session };
}

export async function updateRegistrationStep(userId, patch) {
  await db.updateRegistration(userId, patch);
}

export async function createStaffCustomer(body = {}) {
  const { normalizeSignupEmail, normalizeSignupPhone } = await import('./contactIdentity.js');
  const fullName = String(body.name || '').trim();
  const email = normalizeSignupEmail(body.email);
  const phone = normalizeSignupPhone(body.phone);
  const planId = String(body.planId || '').trim();
  const password = String(body.password || '');
  if (!fullName) {
    const err = new Error('יש למלא שם');
    err.status = 400;
    throw err;
  }
  if (!planId) {
    const err = new Error('יש לבחור מסלול');
    err.status = 400;
    throw err;
  }
  if (password.length < 6) {
    const err = new Error('סיסמה זמנית של 6 תווים לפחות');
    err.status = 400;
    throw err;
  }

  const live = store.getMutableState();
  const plan = (live.plans || []).find((p) => p.id === planId);
  if (!plan) {
    const err = new Error('המסלול לא נמצא');
    err.status = 400;
    throw err;
  }

  if (!isDbEnabled) {
    const row = {
      id: `manual-${Date.now()}`,
      name: fullName,
      phone,
      email,
      planId,
      plan: planId,
      status: 'פעיל',
      joined: new Date().toLocaleDateString('he-IL'),
      joinedAt: new Date().toISOString(),
      points: `0/${plan.points}`,
    };
    live.seedCustomers = [row, ...(live.seedCustomers || [])];
    return row;
  }

  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  await db.assertUniqueContact({ email, phone });
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone: phone || '' },
  });
  if (error) throwHe(error, 400, 'יצירת הלקוחה נכשלה');

  const now = new Date().toISOString();
  await db.ensureUserProfile(data.user.id, {
    full_name: fullName,
    email,
    phone,
    subscribed: true,
    plan_id: planId,
    points_balance: plan.points,
    credits: 0,
    registration_step: 7,
    terms_accepted_at: now,
  });
  const { error: updateError } = await supabase
    .from('profiles')
    .update({
      full_name: fullName,
      email,
      phone,
      subscribed: true,
      plan_id: planId,
      points_balance: plan.points,
      registration_step: 7,
      terms_accepted_at: now,
      updated_at: now,
    })
    .eq('id', data.user.id);
  if (updateError) throwHe(updateError, 502, 'שמירת הלקוחה נכשלה');
  live.staffCustomers = await db.loadStaffCustomers('admin');
  return { id: data.user.id };
}

export { isDbEnabled };

import { isDbEnabled, getSupabase } from './supabase.js';

function adminEmail() {
  return (process.env.ADMIN_EMAIL || 'admin@gmail.com').trim().toLowerCase();
}

export function resolveUserRole(profile) {
  if ((profile?.email || '').trim().toLowerCase() === adminEmail()) {
    return 'admin';
  }
  return profile?.role || 'customer';
}

function rowToUnit(row) {
  return {
    id: row.id,
    modelId: row.model_id,
    status: row.status,
    demoOnly: row.demo_only,
    ownerUserId: row.owner_user_id,
  };
}

function rowToOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    customerName: row.customer_name,
    items: row.items || [],
    returnItems: row.return_items || [],
    newItems: row.new_items || [],
    status: row.status,
    date: row.order_date,
    qr: row.qr,
    pouchId: row.pouch_id,
  };
}

function rowToPouch(row) {
  return {
    id: row.id,
    userId: row.user_id,
    qr: row.qr,
    orderId: row.order_id,
    customerName: row.customer_name,
    returnItems: row.return_items || [],
    newItems: row.new_items || [],
    status: row.status,
    scanned: row.scanned,
    createdAt: row.created_at_label,
    demoCustomer: row.demo_customer,
    pendingPoints: row.pending_points,
    pointsCredited: row.points_credited,
    inventoryCleared: row.inventory_cleared,
  };
}

export async function loadCatalogIntoState(state) {
  const [plansRes, productsRes, unitsRes, seedOrdersRes, seedPouchesRes] =
    await Promise.all([
      getSupabase().from('plans').select('*'),
      getSupabase().from('products').select('*'),
      getSupabase().from('units').select('*'),
      getSupabase().from('orders').select('*').is('user_id', null),
      getSupabase().from('return_pouches').select('*').is('user_id', null),
    ]);

  if (plansRes.error) throw plansRes.error;
  if (productsRes.error) throw productsRes.error;
  if (unitsRes.error) throw unitsRes.error;

  state.plans = (plansRes.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    points: p.points,
    maxItems: p.max_items,
    exchanges: p.exchanges,
    shipping: p.shipping,
    tagline: p.tagline,
  }));

  state.products = (productsRes.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    metal: p.metal,
    stone: p.stone,
    points: p.points,
    price: p.price,
  }));

  state.units = (unitsRes.data || []).map(rowToUnit);

  const seedOrders = (seedOrdersRes.data || []).map(rowToOrder);
  const seedPouches = (seedPouchesRes.data || []).map(rowToPouch);

  state.seedCustomers = [
    { name: 'נועה כהן', plan: 'Signature', points: '520/800', status: 'פעיל' },
    { name: 'תמר לוי', plan: 'Prestige', points: '1100/1400', status: 'פעיל' },
    { name: 'שני אברהם', plan: 'Essentials', points: '0/400', status: 'מוקפא' },
  ];

  return { seedOrders, seedPouches };
}

export async function ensureUserProfile(userId, patch = {}) {
  const admin = getSupabase();
  if (!admin) throw new Error('Database not configured');

  async function readProfile() {
    const { data, error } = await admin.from('profiles').select('*').eq('id', userId).limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }

  let existing = await readProfile();

  // Trigger handle_new_user usually creates the row; wait briefly if racing.
  if (!existing) {
    await new Promise((r) => setTimeout(r, 300));
    existing = await readProfile();
  }

  if (existing) {
    if (!Object.keys(patch).length) return existing;
    const { data, error } = await admin
      .from('profiles')
      .update(patch)
      .eq('id', userId)
      .select('*')
      .limit(1);
    if (error) throw error;
    return data?.[0] || existing;
  }

  const { data: authData, error: authError } = await admin.auth.admin.getUserById(userId);
  if (authError) throw authError;

  const meta = authData.user.user_metadata || {};
  const row = {
    id: userId,
    email: patch.email ?? authData.user.email,
    full_name: patch.full_name ?? meta.full_name ?? '',
    phone: patch.phone ?? meta.phone ?? '',
    registration_step: patch.registration_step ?? 0,
    ...patch,
  };

  const { data, error } = await admin.from('profiles').upsert(row, { onConflict: 'id' }).select('*').limit(1);
  if (error) throw error;
  return data?.[0];
}

async function loadProfile(userId) {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function loadUserSession(userId, state) {
  let profile = await loadProfile(userId);
  if (!profile) {
    profile = await ensureUserProfile(userId);
  }

  const [ordersRes, pouchesRes, ownedUnitsRes] = await Promise.all([
    getSupabase().from('orders').select('*').eq('user_id', userId),
    getSupabase().from('return_pouches').select('*').eq('user_id', userId),
    getSupabase().from('units').select('*').eq('owner_user_id', userId),
  ]);

  if (ordersRes.error) throw ordersRes.error;
  if (pouchesRes.error) throw pouchesRes.error;
  if (ownedUnitsRes.error) throw ownedUnitsRes.error;

  state.currentUserId = userId;
  state.currentUserRole = resolveUserRole(profile);
  state.currentUserName = profile.full_name || profile.email || 'לקוחה';
  state.subscribed = Boolean(profile.subscribed || profile.plan_id);
  state.planId = profile.plan_id;
  state.pointsBalance = profile.points_balance;
  state.credits = profile.credits;
  state.cart = profile.cart || [];
  state.exchangeReturns = profile.exchange_returns || [];
  state.exchangeCart = profile.exchange_cart || [];
  state.myItems = profile.my_items || [];
  state.flash = profile.flash;
  state.lastPouchId = profile.last_pouch_id;
  state.orderCounter = profile.order_counter;
  state.pouchCounter = profile.pouch_counter;
  state.registration = {
    step: profile.registration_step,
    phone: profile.phone,
    phoneVerified: profile.phone_verified,
    emailVerified: profile.email_verified,
    idDocumentUrl: profile.id_document_url,
    signatureCompleted: profile.signature_completed,
    paymentMethodAdded: profile.payment_method_added,
    fullName: profile.full_name,
    email: profile.email,
  };

  for (const row of ownedUnitsRes.data || []) {
    const u = rowToUnit(row);
    const idx = state.units.findIndex((x) => x.id === u.id);
    if (idx >= 0) state.units[idx] = u;
    else state.units.push(u);
  }

  const userOrders = (ordersRes.data || []).map(rowToOrder);
  const userPouches = (pouchesRes.data || []).map(rowToPouch);

  return { userOrders, userPouches, profile };
}

async function persistUserUnits(userId, state) {
  const client = getSupabase();
  if (!client) throw new Error('Database not configured');
  const unitIds = new Set(state.myItems || []);
  for (const o of state.orders) {
    if (o.userId !== userId) continue;
    for (const uid of o.items || []) unitIds.add(uid);
    for (const uid of o.returnItems || []) unitIds.add(uid);
  }

  for (const uid of unitIds) {
    const u = state.units.find((x) => x.id === uid);
    if (!u) continue;
    const { error } = await client.from('units').upsert({
      id: u.id,
      model_id: u.modelId,
      status: u.status,
      demo_only: u.demoOnly ?? false,
      owner_user_id: u.ownerUserId || userId,
    });
    if (error) throw error;
  }
}

export async function persistUserSession(userId, state, userOrders, userPouches, userToken) {
  // Always use the secret/admin client for writes so RLS never blocks server flows.
  const client = getSupabase();
  if (!client) throw new Error('Database not configured');

  const profileUpdate = {
    subscribed: state.subscribed,
    plan_id: state.planId,
    points_balance: state.pointsBalance,
    credits: state.credits,
    cart: state.cart,
    exchange_returns: state.exchangeReturns,
    exchange_cart: state.exchangeCart,
    my_items: state.myItems,
    flash: state.flash,
    last_pouch_id: state.lastPouchId,
    order_counter: state.orderCounter,
    pouch_counter: state.pouchCounter,
    registration_step: state.registration?.step ?? 0,
    phone: state.registration?.phone,
    phone_verified: state.registration?.phoneVerified ?? false,
    email_verified: state.registration?.emailVerified ?? false,
    id_document_url: state.registration?.idDocumentUrl,
    signature_completed: state.registration?.signatureCompleted ?? false,
    payment_method_added: state.registration?.paymentMethodAdded ?? false,
    full_name: state.registration?.fullName,
    updated_at: new Date().toISOString(),
  };

  const { error: profileError } = await client
    .from('profiles')
    .update(profileUpdate)
    .eq('id', userId);
  if (profileError) throw profileError;

  await persistUserUnits(userId, state);

  const allUserOrders = [
    ...userOrders,
    ...state.orders.filter((o) => o.userId === userId),
  ];
  const uniqueOrders = [...new Map(allUserOrders.map((o) => [o.id, o])).values()];

  for (const o of uniqueOrders) {
    const { error } = await client.from('orders').upsert({
      id: o.id,
      user_id: o.userId || userId,
      type: o.type,
      customer_name: o.customerName,
      items: o.items,
      return_items: o.returnItems || [],
      new_items: o.newItems || [],
      status: o.status,
      order_date: o.date,
      qr: o.qr,
      pouch_id: o.pouchId,
    });
    if (error) throw error;
  }

  const allUserPouches = [
    ...userPouches,
    ...state.returnPouches.filter((p) => p.userId === userId),
  ];
  const uniquePouches = [...new Map(allUserPouches.map((p) => [p.id, p])).values()];

  for (const p of uniquePouches) {
    const { error } = await client.from('return_pouches').upsert({
      id: p.id,
      user_id: p.userId || userId,
      qr: p.qr,
      order_id: p.orderId,
      customer_name: p.customerName,
      return_items: p.returnItems,
      new_items: p.newItems || [],
      status: p.status,
      scanned: p.scanned,
      created_at_label: p.createdAt,
      demo_customer: p.demoCustomer ?? true,
      pending_points: p.pendingPoints ?? 0,
      points_credited: p.pointsCredited ?? false,
      inventory_cleared: p.inventoryCleared ?? false,
    });
    if (error) throw error;
  }
}

export async function updateRegistration(userId, patch, _userToken = null) {
  const client = getSupabase();
  if (!client) throw new Error('Database not configured');
  const { error } = await client.from('profiles').update(patch).eq('id', userId);
  if (error) throw error;
}

export async function getUserRole(userId) {
  let profile = await loadProfile(userId);
  if (!profile) {
    profile = await ensureUserProfile(userId);
  }
  return resolveUserRole(profile);
}

export async function ensureAdminByEmail(userId, email) {
  if ((email || '').trim().toLowerCase() !== adminEmail()) return false;

  const patch = {
    subscribed: false,
    plan_id: null,
    points_balance: 0,
    cart: [],
    exchange_returns: [],
    exchange_cart: [],
    my_items: [],
    role: 'admin',
  };

  const { error } = await getSupabase().from('profiles').update(patch).eq('id', userId);
  if (error) {
    const fallback = { ...patch };
    delete fallback.role;
    const { error: fallbackError } = await getSupabase()
      .from('profiles')
      .update(fallback)
      .eq('id', userId);
    if (fallbackError) throw fallbackError;
  }
  return true;
}

export async function persistGlobalCatalog(state, seedOrders, seedPouches) {
  for (const u of state.units.filter((x) => !x.demoOnly && !x.ownerUserId)) {
    const { error } = await getSupabase().from('units').upsert({
      id: u.id,
      model_id: u.modelId,
      status: u.status,
      demo_only: false,
      owner_user_id: null,
    });
    if (error) throw error;
  }

  for (const o of seedOrders) {
    const { error } = await getSupabase().from('orders').upsert({
      id: o.id,
      user_id: null,
      type: o.type,
      customer_name: o.customerName,
      items: o.items,
      return_items: o.returnItems || [],
      new_items: o.newItems || [],
      status: o.status,
      order_date: o.date,
      qr: o.qr,
      pouch_id: o.pouchId,
    });
    if (error) throw error;
  }

  for (const p of seedPouches) {
    const { error } = await getSupabase().from('return_pouches').upsert({
      id: p.id,
      user_id: null,
      qr: p.qr,
      order_id: p.orderId,
      customer_name: p.customerName,
      return_items: p.returnItems,
      new_items: p.newItems || [],
      status: p.status,
      scanned: p.scanned,
      created_at_label: p.createdAt,
      demo_customer: p.demoCustomer ?? false,
      pending_points: p.pendingPoints ?? 0,
      points_credited: p.pointsCredited ?? false,
      inventory_cleared: p.inventoryCleared ?? false,
    });
    if (error) throw error;
  }

  for (const p of state.plans) {
    await getSupabase().from('plans').upsert({
      id: p.id,
      name: p.name,
      price: p.price,
      points: p.points,
      max_items: p.maxItems,
      exchanges: p.exchanges,
      shipping: p.shipping,
      tagline: p.tagline,
    });
  }

  for (const p of state.products) {
    await getSupabase().from('products').upsert({
      id: p.id,
      name: p.name,
      category: p.category,
      metal: p.metal,
      stone: p.stone,
      points: p.points,
      price: p.price,
    });
  }
}

export { isDbEnabled };

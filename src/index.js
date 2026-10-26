import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import * as store from './store.js';
import * as session from './session.js';
import * as db from './db.js';
import { pingDatabase, getConfigStatus, getUserFromToken, isDbEnabled } from './supabase.js';
import { clientIp, parseSignupLegal } from './signupLegal.js';
import { sendContact } from './contact.js';
import { normalizeSignupEmail, normalizeSignupPhone, signupConflictError } from './contactIdentity.js';
import { checkEmailCode, issueEmailCode } from './emailVerify.js';
import { checkSmsCode, issueSmsCode, smsVerificationEnabled } from './smsVerify.js';
import { signupProofValid, signupVerifyProof } from './signupProof.js';
import { heError } from './heError.js';
import { staffOpenDocument } from './idVault.js';
import * as payments from './payments.js';
import { broadcastMarketing, listMarketingRecipients } from './marketing.js';

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const corsOrigins = new Set(
  [
    ...CORS_ORIGIN.split(',').map((o) => o.trim()),
    'https://shinedy.co',
    'https://www.shinedy.co',
  ].filter(Boolean),
);

app.use(
  cors({
    origin(origin, callback) {
      const allowed =
        !origin ||
        corsOrigins.has(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      callback(null, allowed);
    },
  }),
);
app.use(express.json({ limit: '8mb' }));

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'הבקשה אינה תקינה' });
    return;
  }
  next(err);
});

app.get('/', (_req, res) => {
  res.redirect('/api/health');
});

function needsEmailVerification(_snapshot) {
  return false;
}

function needsPhoneVerification(snapshot) {
  if (!smsVerificationEnabled()) return false;
  const role = snapshot?.auth?.role;
  if (role === 'admin' || role === 'warehouse') return false;
  return !snapshot?.registration?.phoneVerified;
}

async function sendVerifyIfNeeded(snapshot, { dispatch = true } = {}) {
  const emailNeeded = needsEmailVerification(snapshot);
  const phoneNeeded = needsPhoneVerification(snapshot);
  let emailSendError = null;
  let smsSendError = null;
  if (dispatch) {
    if (emailNeeded && snapshot?.registration?.email) {
      try {
        await issueEmailCode(snapshot.registration.email);
      } catch (e) {
        if (e.status !== 429) {
          console.error('email verify send:', e.message || e);
          emailSendError = e.message || 'שליחת המייל נכשלה';
        }
      }
    }
    if (phoneNeeded && snapshot?.registration?.phone) {
      try {
        await issueSmsCode(snapshot.registration.phone);
      } catch (e) {
        if (e.status !== 429) {
          console.error('sms verify send:', e.message || e);
          smsSendError = e.message || 'שליחת ה-SMS נכשלה';
        }
      }
    }
  }
  return {
    needsEmailVerification: emailNeeded,
    needsPhoneVerification: phoneNeeded,
    emailSent: Boolean(emailNeeded && !emailSendError),
    emailSendError,
    smsSendError,
  };
}

function wrap(fn, opts = {}) {
  return async (req, res) => {
    try {
      const data = await session.withRequest(req, () => fn(req), opts);
      if (data?.session) {
        res.json(data);
        return;
      }
      res.json(data ?? store.getSnapshot());
    } catch (e) {
      const message = e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message;
      res.status(e.status || 400).json({ error: heError(message) });
    }
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock: process.env.MOCK_MODE === 'true',
    database: session.isDbEnabled,
    config: getConfigStatus(),
  });
});

app.get('/api/health/db', async (_req, res) => {
  const result = await pingDatabase();
  res.status(result.ok ? 200 : 503).json(result);
});

app.get('/api/state', wrap(() => store.getSnapshot(), { skipPersist: true }));

app.post('/api/contact', async (req, res) => {
  try {
    const result = await sendContact(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'שליחת הפנייה נכשלה') });
  }
});

app.post('/api/flash/clear', wrap(() => store.clearFlash(), { auth: false }));

app.post('/api/auth/check-signup', async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || '').trim();
    const email = rawEmail ? normalizeSignupEmail(rawEmail) : '';
    const rawPhone = String(req.body?.phone || '').trim();
    const phone = rawPhone ? normalizeSignupPhone(rawPhone) : '';
    if (!email && !phone) {
      throw new Error('חסרים אימייל או טלפון');
    }
    if (session.isDbEnabled) {
      const field = await db.findContactConflict({ email, phone });
      if (field) throw signupConflictError(field);
    }
    res.json({ ok: true });
  } catch (e) {
    if (!e.status) console.error('check-signup:', e.message || e);
    res.status(e.status || 400).json({ error: heError(e.message, 'בדיקת ההרשמה נכשלה') });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email: rawEmail, password, fullName, phone, address: rawAddress } = req.body || {};
    if (!rawEmail || !password || !fullName?.trim()) {
      throw new Error('חסרים שם, אימייל או סיסמה');
    }
    const email = normalizeSignupEmail(rawEmail);
    const mobile = normalizeSignupPhone(phone);
    const address = {
      street: String(rawAddress?.street || '').trim(),
      houseNo: String(rawAddress?.houseNo || '').trim(),
      apt: String(rawAddress?.apt || '').trim(),
      city: String(rawAddress?.city || '').trim(),
      zip: String(rawAddress?.zip || '').trim(),
      notes: String(rawAddress?.notes || '').trim(),
    };
    if (!address.street || !address.houseNo || !address.city) {
      throw new Error('יש למלא כתובת למשלוח (רחוב, מספר בית ועיר)');
    }
    const legal = parseSignupLegal(req.body);
    legal.signupIp = clientIp(req);
    if (session.isDbEnabled) {
      const { user, session: authSession } = await session.registerUser({
        email,
        password,
        fullName: fullName.trim(),
        phone: mobile,
        address,
        ...legal,
      });
      await db.ensureAdminByEmail(user.id, email);
      req.headers.authorization = `Bearer ${authSession.access_token}`;
      // The membership starts only after the first month is paid on the payment page.
      const snapshot = await session.withRequest(req, () => {
        const st = store.getMutableState();
        st.address = address;
        if (st.registration) st.registration.address = address;
        if (st.registration) {
          st.registration.emailVerified = true;
          st.registration.phoneVerified =
            !smsVerificationEnabled() || signupProofValid('sms', mobile, req.body?.phoneProof);
        }
        return store.getSnapshot();
      });
      const pending = await sendVerifyIfNeeded(snapshot);
      res.json({
        session: {
          access_token: authSession.access_token,
          refresh_token: authSession.refresh_token,
          expires_at: authSession.expires_at,
        },
        ...snapshot,
        ...pending,
      });
      return;
    }
    const snapshot = await session.withRequest(req, () => {
      const snap = store.registerMock({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: mobile,
        address,
        ...legal,
      });
      if (req.body?.planId) store.subscribe(req.body.planId);
      return store.getSnapshot() || snap;
    });
    res.json(snapshot);
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'שגיאה בהרשמה') });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (session.isDbEnabled) {
      if (!email || !password) throw new Error('חסרים אימייל או סיסמה');
      const { session: authSession } = await session.loginUser({ email, password });
      req.headers.authorization = `Bearer ${authSession.access_token}`;
      const snapshot = await session.withRequest(req, () => store.getSnapshot(), {
        skipPersist: true,
      });
      res.json({
        session: {
          access_token: authSession.access_token,
          refresh_token: authSession.refresh_token,
          expires_at: authSession.expires_at,
        },
        ...snapshot,
      });
      return;
    }
    const snapshot = await session.withRequest(req, () => store.login());
    res.json(snapshot);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('login:', e.message || e);
    const fallback = e.status === 401 ? 'אימייל או סיסמה שגויים' : 'ההתחברות נכשלה. נסי שוב';
    res.status(e.status || 400).json({ error: heError(e.message, fallback) });
  }
});

app.post('/api/auth/verify-email', wrap(async (req) => {
  const st = store.getMutableState();
  const email = String(req.body?.email || st.registration?.email || '').trim();
  await checkEmailCode(email, req.body?.code);
  if (st.registration) st.registration.emailVerified = true;
  const snapshot = store.getSnapshot();
  const pending = await sendVerifyIfNeeded(snapshot, { dispatch: false });
  return { emailVerified: true, ...snapshot, ...pending };
}, { auth: true }));

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const email = normalizeSignupEmail(String(req.body?.email || ''));
    await issueEmailCode(email);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'שליחת הקוד נכשלה') });
  }
});

app.post('/api/auth/check-email-code', async (req, res) => {
  try {
    const email = normalizeSignupEmail(String(req.body?.email || ''));
    await checkEmailCode(email, req.body?.code);
    res.json({ ok: true, proof: signupVerifyProof('email', email) });
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'הקוד שגוי') });
  }
});

app.post('/api/auth/check-phone-code', async (req, res) => {
  try {
    const phone = normalizeSignupPhone(String(req.body?.phone || ''));
    await checkSmsCode(phone, req.body?.code);
    res.json({ ok: true, proof: signupVerifyProof('sms', phone) });
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'הקוד שגוי') });
  }
});

app.post('/api/auth/verify-phone', wrap(async (req) => {
  const st = store.getMutableState();
  const phone = String(req.body?.phone || st.registration?.phone || '').trim();
  await checkSmsCode(phone, req.body?.code);
  if (st.registration) st.registration.phoneVerified = true;
  return { phoneVerified: true, ...store.getSnapshot() };
}, { auth: true }));

app.post('/api/auth/resend-phone-verification', async (req, res) => {
  try {
    const phone = normalizeSignupPhone(String(req.body?.phone || ''));
    await issueSmsCode(phone);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'שליחת ה-SMS נכשלה') });
  }
});

app.post('/api/auth/logout', wrap(() => store.logout(), { auth: false }));

app.patch(
  '/api/auth/registration',
  wrap((req) => {
    const patch = req.body || {};
    const st = store.getMutableState();
    st.registration = {
      ...(st.registration || {}),
      step: patch.step ?? st.registration?.step ?? 0,
      phone: patch.phone ?? st.registration?.phone,
      phoneVerified: patch.phoneVerified ?? st.registration?.phoneVerified ?? false,
      emailVerified: patch.emailVerified ?? st.registration?.emailVerified ?? false,
      signatureCompleted:
        patch.signatureCompleted ?? st.registration?.signatureCompleted ?? false,
      paymentMethodAdded:
        patch.paymentMethodAdded ?? st.registration?.paymentMethodAdded ?? false,
      termsAcceptedAt: patch.termsAcceptedAt ?? st.registration?.termsAcceptedAt,
      privacyAcceptedAt: patch.privacyAcceptedAt ?? st.registration?.privacyAcceptedAt,
      noticesAcceptedAt: patch.noticesAcceptedAt ?? st.registration?.noticesAcceptedAt,
      fullName: st.registration?.fullName,
      email: st.registration?.email,
    };
    if (patch.address && typeof patch.address === 'object') {
      const next = {
        ...(st.address || {}),
        ...store.clientAddress(patch.address),
        street: String(patch.address.street ?? st.address?.street ?? '').trim(),
        houseNo: String(patch.address.houseNo ?? st.address?.houseNo ?? '').trim(),
        apt: String(patch.address.apt ?? st.address?.apt ?? '').trim(),
        city: String(patch.address.city ?? st.address?.city ?? '').trim(),
        zip: String(patch.address.zip ?? st.address?.zip ?? '').trim(),
      };
      st.address = next;
      st.registration.address = next;
    }
    return store.getSnapshot();
  }, { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }),
);

app.post(
  '/api/subscribe',
  wrap((req) => payments.subscribeWithSavedCard(req.body?.planId), {
    auth: session.isDbEnabled,
    customerOnly: session.isDbEnabled,
  }),
);

app.post('/api/subscribe/change', wrap((req) => store.changePlan(req.body.planId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/purchase', wrap((req) => payments.purchaseWithSavedCard(req.body || {}), { auth: false }));

app.post('/api/payments/checkout', wrap((req) => payments.startCheckout(req.body || {}), { auth: false }));

// Not queued through wrap(): completing a payment loads the paying customer itself.
app.post('/api/payments/return', async (req, res) => {
  try {
    res.json(await payments.completeCheckout(req.body?.query));
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message, 'אימות התשלום נכשל') });
  }
});

app.get('/api/cron/billing', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    res.json(await payments.runBilling());
  } catch (e) {
    console.error('cron billing:', e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

app.post(
  '/api/purchases/:id/shipped',
  wrap((req) => store.markPurchaseShipped(req.params.id), {
    staff: true,
    staffRoles: ['admin', 'warehouse'],
    skipStaffCustomers: true,
    persist: 'order',
  }),
);

app.post(
  '/api/subscribe/cancel',
  wrap(() => payments.settleAfterAction(store.cancelSubscription()), {
    auth: session.isDbEnabled,
    customerOnly: session.isDbEnabled,
  }),
);

app.post(
  '/api/subscribe/suspend',
  wrap(() => payments.settleAfterAction(store.suspendOwnSubscription()), {
    auth: session.isDbEnabled,
    customerOnly: session.isDbEnabled,
  }),
);

app.post(
  '/api/subscribe/resume',
  wrap(() => payments.settleAfterAction(store.resumeOwnSubscription()), {
    auth: session.isDbEnabled,
    customerOnly: session.isDbEnabled,
  }),
);

app.post('/api/cart/add', wrap((req) => store.addToCart(req.body.productId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/cart/remove', wrap((req) => store.removeFromCart(req.body.productId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/cart/confirm', wrap((req) => payments.confirmOrder(req.body || {}), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post(
  '/api/exchange/toggle-return',
  wrap((req) => store.toggleReturn(req.body.unitId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }),
);

app.post(
  '/api/exchange/add',
  wrap((req) => store.addExchangeProduct(req.body.productId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }),
);

app.post(
  '/api/exchange/remove',
  wrap((req) => store.removeExchangeProduct(req.body.productId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }),
);

app.post('/api/exchange/confirm', wrap(() => payments.confirmExchange(), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/returns/last/clear', wrap(() => store.clearLastPouch(), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post(
  '/api/returns/:pouchId/cancel',
  wrap((req) => payments.settleAfterAction(store.cancelReturnPouch(req.params.pouchId)), {
    auth: session.isDbEnabled,
    customerOnly: session.isDbEnabled,
  }),
);

app.patch(
  '/api/admin/plans/:id',
  wrap((req) => store.updatePlan(req.params.id, req.body.field, req.body.value), { staff: true }),
);

app.post(
  '/api/admin/products',
  wrap((req) => store.createProduct(req.body || {}), {
    staff: true,
    staffRoles: ['admin', 'warehouse'],
    skipStaffCustomers: true,
    persist: 'product',
    productId: (req) => store.productCodeOf(req.body?.id || req.body?.sku),
  }),
);

app.patch(
  '/api/admin/products/:id',
  wrap((req) => store.updateProduct(req.params.id, req.body.field, req.body.value), {
    staff: true,
    skipStaffCustomers: true,
    persist: 'product',
  }),
);

app.patch(
  '/api/admin/units/:id',
  wrap((req) => store.setUnitStatus(req.params.id, req.body.status), { staff: true }),
);

app.post(
  '/api/warehouse/orders/:id/advance',
  wrap((req) => store.advanceOrder(req.params.id), {
    staff: true,
    staffRoles: ['admin', 'warehouse'],
    skipStaffCustomers: true,
    persist: 'order',
  }),
);

app.post(
  '/api/warehouse/receive',
  wrap((req) => store.receiveUnit(req.body.modelId, req.body.code), {
    staff: true,
    skipStaffCustomers: true,
    persist: 'product',
    productId: (req) => req.body?.modelId,
  }),
);

app.post(
  '/api/warehouse/returns/scan',
  wrap((req) => store.scanPouch(req.body.qr), { staff: true, staffRoles: ['admin', 'warehouse'] }),
);

app.post(
  '/api/warehouse/returns/:pouchId/confirm-contents',
  wrap((req) => store.confirmPouchContents(req.params.pouchId), { staff: true }),
);

app.post(
  '/api/warehouse/returns/:pouchId/qc',
  wrap((req) => store.pouchItemQC(req.params.pouchId, req.body.unitId, req.body.result), {
    staff: true,
  }),
);

app.post(
  '/api/warehouse/returns/:unitId/qc-unit',
  wrap((req) => store.returnQC(req.params.unitId, req.body.result), { staff: true }),
);

app.post(
  '/api/warehouse/cleaning/:unitId/available',
  wrap((req) => store.markCleanAvailable(req.params.unitId), { staff: true }),
);

app.post('/api/reset', wrap(() => store.resetStore(), { staff: true }));

// Favorites bypass the shared store queue: they are a single-table read/write.
async function requireUser(req, staffRoles = null) {
  if (!isDbEnabled) {
    const err = new Error('המועדפים זמינים רק לחשבון מחובר');
    err.status = 401;
    throw err;
  }
  await session.initDbIfNeeded();
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = await getUserFromToken(token);
  if (!user) {
    const err = new Error('יש להתחבר');
    err.status = 401;
    throw err;
  }
  if (staffRoles) {
    const role = await db.getUserRole(user.id);
    if (!staffRoles.includes(role)) {
      const err = new Error('אין הרשאת ניהול');
      err.status = 403;
      throw err;
    }
  }
  return user;
}

function favoritesRoute(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const raw = `${e.message || ''} ${e.details || ''}`;
      const message = /foreign key|favorites_product_id_fkey/i.test(raw) ? 'התכשיט לא נמצא' : e.message;
      res.status(e.status || 400).json({ error: heError(message, 'שמירת המועדפים נכשלה') });
    }
  };
}

function productIdOf(req) {
  const id = String(req.body?.productId || '').trim();
  if (!id) {
    const err = new Error('חסר מזהה תכשיט');
    err.status = 400;
    throw err;
  }
  return id;
}

app.get('/api/favorites', favoritesRoute(async (req) => {
  const user = await requireUser(req);
  return { ids: await db.listFavoriteIds(user.id) };
}));

app.post('/api/favorites', favoritesRoute(async (req) => {
  const user = await requireUser(req);
  return { ids: await db.setFavorite(user.id, productIdOf(req), req.body?.on !== false) };
}));

app.post('/api/favorites/merge', favoritesRoute(async (req) => {
  const user = await requireUser(req);
  const known = new Set(store.getMutableState().products.map((p) => p.id));
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => known.has(id));
  return { ids: await db.addFavorites(user.id, ids) };
}));

app.get('/api/admin/favorites', favoritesRoute(async (req) => {
  await requireUser(req, ['admin', 'warehouse']);
  return { favorites: await db.listAllFavorites() };
}));

app.get(
  '/api/admin/overview',
  wrap(async () => {
    if (!isDbEnabled()) {
      return { favoriteSaves: 0, abandonedCarts: 0, contactPending: 0, liveVisitors: 0 };
    }
    return db.adminDashboardExtras();
  }, { staff: true, staffRoles: ['admin', 'warehouse'] }),
);

app.post(
  '/api/admin/customers',
  wrap(async (req) => {
    await session.createStaffCustomer(req.body || {});
    return store.getSnapshot();
  }, { staff: true, staffRoles: ['admin'] }),
);

app.get(
  '/api/admin/marketing/recipients',
  wrap(async () => {
    const recipients = await listMarketingRecipients();
    return { count: recipients.length };
  }, { staff: true, staffRoles: ['admin'] }),
);

app.post(
  '/api/admin/marketing/broadcast',
  wrap(async (req) => broadcastMarketing(req.body || {}), {
    staff: true,
    staffRoles: ['admin'],
  }),
);

app.delete('/api/admin/customers/:id', async (req, res) => {
  try {
    const data = await session.deleteCustomer(req, req.params.id);
    res.json(data);
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message) });
  }
});

app.post('/api/admin/customers/:id/subscription', async (req, res) => {
  try {
    const { action, planId } = req.body || {};
    const data = await session.runForCustomer(req, req.params.id, async () => {
      if (action === 'collect') store.retryFailedCharges();
      else store.staffSubscriptionAction(action, planId);
      store.accrueSubscriptionCharges();
      await payments.collectOutstanding();
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message) });
  }
});

app.patch('/api/admin/customers/:id', async (req, res) => {
  try {
    const data = await session.runForCustomer(req, req.params.id, () =>
      store.staffUpdateCustomerDetails(req.body || {}),
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 400).json({ error: heError(e.message) });
  }
});

app.patch(
  '/api/admin/membership-terms',
  wrap((req) => store.updateMembershipTerms(req.body?.terms), { staff: true, staffRoles: ['admin'] }),
);

app.get(
  '/api/admin/customers/:id/id-document',
  wrap(async (req) => {
    return staffOpenDocument(req.params.id, {
      staffUserId: store.getMutableState().currentUserId,
    });
  }, { staff: true, staffRoles: ['admin'] }),
);

app.post(
  '/api/admin/clear-users',
  wrap(async () => {
    const result = await session.deleteAllUsers();
    store.resetStore();
    return { ok: true, ...result, snapshot: store.getSnapshot() };
  }, { staff: true }),
);

export default app;

if (process.env.VERCEL !== '1') {
  session
    .initDbIfNeeded()
    .catch((err) => {
      console.error('DB init failed:', err?.message || err);
    })
    .finally(() => {
      app.listen(PORT, () => {
        console.log(`Shinedy API on http://localhost:${PORT} (db=${session.isDbEnabled})`);
      });
    });
}

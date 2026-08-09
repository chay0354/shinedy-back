import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import * as store from './store.js';
import * as session from './session.js';
import * as db from './db.js';
import { pingDatabase, getConfigStatus } from './supabase.js';

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const corsOrigins = CORS_ORIGIN.split(',').map((o) => o.trim());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
  }),
);
app.use(express.json());

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON in request body' });
    return;
  }
  next(err);
});

app.get('/', (_req, res) => {
  res.redirect('/api/health');
});

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
      res.status(e.status || 400).json({ error: message });
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

app.get('/api/state', wrap(() => store.getSnapshot()));

app.post('/api/flash/clear', wrap(() => store.clearFlash(), { auth: false }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body || {};
    if (!email || !password || !fullName?.trim()) {
      throw new Error('חסרים שם, אימייל או סיסמה');
    }
    if (session.isDbEnabled) {
      const { user, session: authSession } = await session.registerUser({
        email,
        password,
        fullName: fullName.trim(),
      });
      await db.ensureAdminByEmail(user.id, email);
      req.headers.authorization = `Bearer ${authSession.access_token}`;
      await session.withRequest(req, () => store.getSnapshot());
      res.json({
        session: {
          access_token: authSession.access_token,
          refresh_token: authSession.refresh_token,
          expires_at: authSession.expires_at,
        },
      ...store.getSnapshot(),
    });
    return;
    }
    const snapshot = await session.withRequest(req, () =>
      store.registerMock({ fullName: fullName.trim(), email: email.trim() }),
    );
    res.json(snapshot);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'שגיאה בהרשמה' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (session.isDbEnabled) {
      if (!email || !password) throw new Error('חסרים אימייל או סיסמה');
      const { session: authSession } = await session.loginUser({ email, password });
      req.headers.authorization = `Bearer ${authSession.access_token}`;
      const snapshot = await session.withRequest(req, () => store.getSnapshot());
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
    res.status(e.status || 400).json({ error: e.message });
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
      idDocumentUrl: patch.idDocumentUrl ?? st.registration?.idDocumentUrl,
      signatureCompleted:
        patch.signatureCompleted ?? st.registration?.signatureCompleted ?? false,
      paymentMethodAdded:
        patch.paymentMethodAdded ?? st.registration?.paymentMethodAdded ?? false,
      fullName: st.registration?.fullName,
      email: st.registration?.email,
    };
    return store.getSnapshot();
  }, { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }),
);

app.post('/api/subscribe', wrap((req) => store.subscribe(req.body.planId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/subscribe/cancel', wrap(() => store.cancelSubscription(), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/cart/add', wrap((req) => store.addToCart(req.body.productId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/cart/remove', wrap((req) => store.removeFromCart(req.body.productId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/cart/confirm', wrap(() => store.confirmOrder(), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

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

app.post('/api/exchange/confirm', wrap(() => store.confirmExchange(), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post('/api/returns/last/clear', wrap(() => store.clearLastPouch(), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }));

app.post(
  '/api/returns/:pouchId/cancel',
  wrap((req) => store.cancelReturnPouch(req.params.pouchId), { auth: session.isDbEnabled, customerOnly: session.isDbEnabled }),
);

app.patch(
  '/api/admin/plans/:id',
  wrap((req) => store.updatePlan(req.params.id, req.body.field, req.body.value), { staff: true }),
);

app.patch(
  '/api/admin/products/:id',
  wrap((req) => store.updateProduct(req.params.id, req.body.field, req.body.value), {
    staff: true,
  }),
);

app.patch(
  '/api/admin/units/:id',
  wrap((req) => store.setUnitStatus(req.params.id, req.body.status), { staff: true }),
);

app.post(
  '/api/warehouse/orders/:id/advance',
  wrap((req) => store.advanceOrder(req.params.id), { staff: true, staffRoles: ['admin', 'warehouse'] }),
);

app.post(
  '/api/warehouse/receive',
  wrap((req) => store.receiveUnit(req.body.modelId), { staff: true }),
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

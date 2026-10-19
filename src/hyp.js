const PAY_URL = 'https://pay.hyp.co.il/p/';
const TIMEOUT_MS = 20000;

function config() {
  return {
    masof: String(process.env.HYP_MASOF || '').trim(),
    key: String(process.env.HYP_KEY || '').trim(),
    passp: String(process.env.HYP_PASSP || '').trim(),
  };
}

export function isHypConfigured() {
  const c = config();
  return Boolean(c.masof && c.key && c.passp);
}

const DECLINE_MESSAGES = {
  3: 'חברת האשראי ביקשה ליצור איתה קשר. נסי כרטיס אחר',
  4: 'העסקה סורבה על ידי חברת האשראי',
  6: 'פרטי הכרטיס או תעודת הזהות שגויים',
  33: 'הכרטיס אינו תקין',
  36: 'תוקף הכרטיס פג',
  39: 'מספר הכרטיס שגוי',
  57: 'לא הוזנה תעודת זהות',
  61: 'מספר הכרטיס חסר',
  997: 'הכרטיס השמור אינו תקף יותר. יש לעדכן כרטיס',
};

export function declineMessage(ccode) {
  const code = Number(ccode);
  return DECLINE_MESSAGES[code] || `התשלום לא אושר (קוד ${ccode}). נסי שוב או עדכני כרטיס`;
}

function paymentError(message, status = 402, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

async function call(params) {
  if (!isHypConfigured()) throw paymentError('התשלום אינו זמין כרגע', 503);
  const query = new URLSearchParams(params).toString();
  return callRaw(query);
}

async function callRaw(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(`${PAY_URL}?${query}`, { signal: ctrl.signal });
    text = (await res.text()).trim();
  } catch (e) {
    throw paymentError('לא ניתן להתחבר לחברת הסליקה. נסי שוב בעוד רגע', 502, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  return text;
}

function parse(text) {
  return Object.fromEntries(new URLSearchParams(text));
}

function clean(value, max = 60) {
  return String(value ?? '')
    .replace(/[&=#?]/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Returns the Hyp payment page URL for one checkout. The redirect back carries
 * `Order` (our payment id), `Id` (Hyp transaction) and `CCode`.
 */
export async function createPaymentPage({ amount, order, info, client = {}, verifyOnly = false }) {
  const c = config();
  const params = {
    action: 'APISign',
    What: 'SIGN',
    Masof: c.masof,
    KEY: c.key,
    PassP: c.passp,
    Sign: 'True',
    MoreData: 'True',
    UTF8: 'True',
    UTF8out: 'True',
    PageLang: 'HEB',
    Coin: '1',
    Amount: verifyOnly ? '1' : Number(amount).toFixed(2),
    Order: order,
    Info: clean(info, 120),
    Tash: '1',
    FixTash: 'True',
    sendemail: verifyOnly ? 'False' : 'True',
  };
  if (verifyOnly) params.J5 = 'J2';
  if (client.firstName) params.ClientName = clean(client.firstName);
  if (client.lastName) params.ClientLName = clean(client.lastName);
  if (client.email) params.email = clean(client.email, 120);
  if (client.cell) params.cell = clean(client.cell, 20);
  if (client.street) params.street = clean(client.street);
  if (client.city) params.city = clean(client.city);
  if (/^\d{9}$/.test(String(client.idNumber || ''))) params.UserId = client.idNumber;

  const text = await call(params);
  const parsed = parse(text);
  if (!parsed.signature) {
    console.error('hyp sign failed:', text.slice(0, 200));
    throw paymentError('לא ניתן לפתוח את דף התשלום כרגע. נסי שוב בעוד רגע', 502);
  }
  return `${PAY_URL}?${text}`;
}

/** Confirms the redirect parameters really came from Hyp (raw query, original order). */
export async function verifyRedirect(rawQuery) {
  const c = config();
  const auth = new URLSearchParams({
    action: 'APISign',
    What: 'VERIFY',
    Masof: c.masof,
    KEY: c.key,
    PassP: c.passp,
  }).toString();
  const text = await callRaw(`${auth}&${String(rawQuery || '').replace(/^\?/, '')}`);
  return parse(text).CCode === '0';
}

export async function fetchToken(transId) {
  const c = config();
  const parsed = parse(
    await call({
      action: 'getToken',
      Masof: c.masof,
      PassP: c.passp,
      TransId: String(transId),
      allowFalse: 'True',
    }),
  );
  if (parsed.CCode !== '0' || !parsed.Token) {
    console.error('hyp getToken failed:', parsed.CCode);
    return null;
  }
  return { token: parsed.Token, tokef: parsed.Tokef || '' };
}

/** Charges a saved card token. Throws a 402 with a Hebrew reason when declined. */
export async function chargeToken({ token, tokef, amount, info, order, idNumber, client = {} }) {
  const c = config();
  const yymm = String(tokef || '').padStart(4, '0');
  const params = {
    action: 'soft',
    Masof: c.masof,
    PassP: c.passp,
    Token: 'True',
    CC: token,
    Tyear: yymm.slice(0, 2),
    Tmonth: yymm.slice(2, 4),
    Amount: Number(amount).toFixed(2),
    Coin: '1',
    UserId: /^\d{9}$/.test(String(idNumber || '')) ? idNumber : '000000000',
    ClientName: clean(client.firstName || 'לקוחה'),
    Info: clean(info, 120) || 'Shinedy',
    UTF8: 'True',
    UTF8out: 'True',
    sendemail: 'True',
  };
  if (order) params.Order = clean(order, 40);
  if (client.lastName) params.ClientLName = clean(client.lastName);
  if (client.email) params.email = clean(client.email, 120);
  if (client.cell) params.cell = clean(client.cell, 20);
  const parsed = parse(await call(params));
  if (parsed.CCode !== '0') {
    throw paymentError(declineMessage(parsed.CCode), 402, { ccode: parsed.CCode, transId: parsed.Id });
  }
  return { transId: parsed.Id, acode: parsed.ACode || '' };
}

/** Voids a same-day transaction before it is transmitted. Returns false when it can't. */
export async function cancelTransaction(transId) {
  if (!transId || !isHypConfigured()) return false;
  const c = config();
  try {
    const parsed = parse(
      await call({ action: 'CancelTrans', Masof: c.masof, PassP: c.passp, TransId: String(transId) }),
    );
    return parsed.CCode === '0';
  } catch (e) {
    console.error('hyp cancel failed:', e?.message || e);
    return false;
  }
}

'use strict';
/*
 * Mitki's Cafe ordering server.
 * Customers order and pay on the website; staff see paid orders on /kitchen.
 * No dependencies: runs on Node 18 or newer.
 *
 * Settings come from environment variables (see .env.example). Secrets are never
 * written to files or logs.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const PAYMENT_MODE = (env.PAYMENT_MODE || 'razorpay').toLowerCase();
const KEY_ID = env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = env.RAZORPAY_WEBHOOK_SECRET || '';
const RZP_BASE = (env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/$/, '');
const KITCHEN_USER = env.KITCHEN_USER || 'staff';
const KITCHEN_PASSWORD = env.KITCHEN_PASSWORD || '';
const KEEP_DAYS = Number(env.KEEP_DAYS) || 60;
const MENU_PATH = path.join(__dirname, 'menu.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

function fail(msg) { console.error('Cannot start: ' + msg); process.exit(1); }
if (!['razorpay', 'test'].includes(PAYMENT_MODE)) fail('PAYMENT_MODE must be "razorpay" or "test".');
if (PAYMENT_MODE === 'test' && env.NODE_ENV === 'production') fail('PAYMENT_MODE=test takes no real payments and is not allowed when NODE_ENV=production.');
if (KITCHEN_PASSWORD.length < 8) fail('set KITCHEN_PASSWORD to at least 8 characters.');
if (PAYMENT_MODE === 'razorpay' && (!KEY_ID || !KEY_SECRET)) fail('set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (or PAYMENT_MODE=test to try the app without real payments).');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Order storage: one JSON file, written atomically ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let orders = {};
try {
  orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')).orders || {};
} catch (e) {
  if (e.code !== 'ENOENT') fail('could not read ' + ORDERS_FILE + ': ' + e.message);
}
let saveTimer = null;
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 200); }
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ orders }));
  fs.renameSync(tmp, ORDERS_FILE);
}
function prune() {
  const now = Date.now();
  let removed = 0;
  Object.keys(orders).forEach(function (id) {
    const o = orders[id];
    const age = now - o.createdAt;
    if (age > KEEP_DAYS * 864e5 || (o.payment !== 'paid' && age > 24 * 36e5)) { delete orders[id]; removed++; }
  });
  if (removed) save();
}
prune();
setInterval(prune, 36e5).unref();

/* ---------- Helpers ---------- */
const rid = () => crypto.randomBytes(9).toString('base64url');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const recent = new Set(Object.values(orders).filter(o => o.createdAt > Date.now() - 864e5).map(o => o.code));
  for (let len = 4; len <= 6; len++) {
    for (let t = 0; t < 40; t++) {
      let c = '';
      for (let i = 0; i < len; i++) c += ALPHA[crypto.randomInt(ALPHA.length)];
      if (!recent.has(c)) return c;
    }
  }
  return rid().slice(0, 6).toUpperCase();
}
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(function () {
  const now = Date.now();
  buckets.forEach(function (b, k) { if (b.reset < now) buckets.delete(k); });
}, 60000).unref();
function ipOf(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? f.split(',').pop().trim() : req.socket.remoteAddress) || 'unknown';
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let n = 0;
    req.on('data', function (c) {
      n += c.length;
      if (n > limit) { reject(new HttpError(413, 'Request too large.')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
  const buf = await readBody(req, 20000);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { throw new HttpError(400, 'Invalid JSON.'); }
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/* ---------- Menu and server-side pricing (the browser's prices are never trusted) ---------- */
function readMenu() { return JSON.parse(fs.readFileSync(MENU_PATH, 'utf8')); }
function priceLines(lines, menu) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Your order is empty.');
  if (lines.length > 30) throw new HttpError(400, 'Too many different items in one order.');
  const byId = new Map(menu.items.map(i => [i.id, i]));
  const seen = new Set();
  const out = [];
  let total = 0, count = 0;
  lines.forEach(function (l) {
    const it = byId.get(String(l && l.id));
    if (!it) throw new HttpError(400, 'An item in your order is no longer on the menu.');
    if (it.price == null) throw new HttpError(400, it.name + ' is not available yet.');
    const qty = l.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Quantity must be between 1 and 20.');
    let name = it.name, unit = it.price, idx = null;
    if (Array.isArray(it.options) && it.options.length) {
      idx = Number.isInteger(l.opt) ? l.opt : 0;
      const o = it.options[idx];
      if (!o) throw new HttpError(400, 'That choice is not available for ' + it.name + '.');
      unit += o.extra || 0;
      name += ' (' + o.label + ')';
    }
    const key = it.id + (idx === null ? '' : '~' + idx);
    if (seen.has(key)) throw new HttpError(400, 'The same item appears twice in the order.');
    seen.add(key);
    count += qty; total += unit * qty;
    out.push({ key: key, name: name, qty: qty, price: unit });
  });
  if (count > 60) throw new HttpError(400, 'Too many items in one order. Please place two orders.');
  return { items: out, total: total };
}

/* ---------- Payments ---------- */
function markPaid(o, paymentId) {
  if (o.payment === 'paid') return false;
  o.payment = 'paid';
  o.paymentId = paymentId;
  o.paidAt = Date.now();
  o.updatedAt = o.paidAt;
  o.status = 'new';
  save();
  console.log('Order ' + o.code + ' paid (' + o.total + ' INR)');
  return true;
}
async function rzpCreateOrder(o) {
  let r, j = {};
  try {
    r = await fetch(RZP_BASE + '/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64') },
      body: JSON.stringify({ amount: Math.round(o.total * 100), currency: 'INR', receipt: o.id, notes: { code: o.code } }),
      signal: AbortSignal.timeout(15000)
    });
    j = await r.json().catch(function () { return {}; });
  } catch (e) {
    console.error('Razorpay request failed:', e.message);
    throw new HttpError(502, 'Payment system is unavailable. Please try again in a moment.');
  }
  if (!r.ok || !j.id) {
    console.error('Razorpay order creation failed:', r.status, j.error && j.error.description);
    throw new HttpError(502, 'Payment system is unavailable. Please try again in a moment.');
  }
  return j.id;
}

/* ---------- Kitchen sign-in (HTTP Basic over HTTPS) ---------- */
function authorized(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const s = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = s.indexOf(':');
  if (i < 0) return false;
  const a = safeEq(s.slice(0, i), KITCHEN_USER);
  const b = safeEq(s.slice(i + 1), KITCHEN_PASSWORD);
  return a && b;
}
function requireKitchen(req, res) {
  const ip = ipOf(req);
  const fb = buckets.get('authfail:' + ip);
  if (fb && fb.reset > Date.now() && fb.n >= 10) { sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' }); return false; }
  if (authorized(req)) return true;
  if (req.headers.authorization) limited('authfail:' + ip, 10, 15 * 60e3);
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mitki\'s Kitchen", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Sign in required.');
  return false;
}

/* ---------- Static files ---------- */
const PAGES = {
  '/': ['index.html', 'text/html; charset=utf-8', false],
  '/style.css': ['style.css', 'text/css; charset=utf-8', false],
  '/customer.js': ['customer.js', 'text/javascript; charset=utf-8', false],
  '/logo.png': ['logo.png', 'image/png', false],
  '/kitchen': ['kitchen.html', 'text/html; charset=utf-8', true],
  '/kitchen.js': ['kitchen.js', 'text/javascript; charset=utf-8', true]
};
const KITCHEN_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'";
function servePage(req, res, entry, urlPath) {
  if (entry[2] && !requireKitchen(req, res)) return;
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), function (err, data) {
    if (err) { sendJson(res, 404, { error: 'Not found.' }); return; }
    const h = { 'Content-Type': entry[1], 'Content-Length': data.length, 'Cache-Control': entry[1] === 'image/png' ? 'public, max-age=86400' : 'no-cache' };
    if (urlPath === '/kitchen') h['Content-Security-Policy'] = KITCHEN_CSP;
    if (entry[2]) h['Cache-Control'] = 'no-store';
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ---------- Routes ---------- */
function ownOrder(req, id) {
  const o = orders[id];
  const tok = req.headers['x-order-token'] || '';
  if (!o || !safeEq(tok, o.token)) throw new HttpError(404, 'Order not found.');
  return o;
}
const TRANSITIONS = { new: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served', 'cancelled'], served: ['new'], cancelled: ['new'] };
const kitchenView = o => ({ id: o.id, code: o.code, items: o.items, total: o.total, mode: o.mode, name: o.name, table: o.table, note: o.note, status: o.status, paymentId: o.paymentId, paidAt: o.paidAt, updatedAt: o.updatedAt });

async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const m = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  if ((m === 'GET' || m === 'HEAD') && PAGES[p]) return servePage(req, res, PAGES[p], p);
  if (m === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true });
  if (m === 'GET' && p === '/api/menu') {
    const menu = readMenu();
    return sendJson(res, 200, { categories: menu.categories, items: menu.items, paymentMode: PAYMENT_MODE });
  }
  if (m === 'POST' && p !== '/api/razorpay/webhook' && !sameOrigin(req)) throw new HttpError(403, 'Blocked.');

  if (m === 'POST' && p === '/api/orders') {
    if (limited('order:' + ipOf(req), 15, 10 * 60e3)) throw new HttpError(429, 'Too many orders from this device. Please wait a few minutes.');
    const b = await readJson(req);
    const mode = b.mode === 'Takeaway' ? 'Takeaway' : b.mode === 'Dine-in' ? 'Dine-in' : null;
    if (!mode) throw new HttpError(400, 'Choose dine-in or takeaway.');
    const name = clean(b.name, 40);
    if (!name) throw new HttpError(400, 'Please enter your name so we can call you.');
    const priced = priceLines(b.items, readMenu());
    const o = {
      id: rid(), code: newCode(), token: rid(), createdAt: Date.now(), updatedAt: Date.now(),
      items: priced.items, total: priced.total, mode: mode, name: name,
      table: mode === 'Dine-in' ? clean(b.table, 10) : '', note: clean(b.note, 200),
      payment: 'pending', paymentId: null, rzpOrderId: null, status: 'new'
    };
    if (PAYMENT_MODE === 'razorpay') o.rzpOrderId = await rzpCreateOrder(o);
    orders[o.id] = o; save();
    return sendJson(res, 201, {
      id: o.id, token: o.token, code: o.code, total: o.total, paymentMode: PAYMENT_MODE,
      razorpay: PAYMENT_MODE === 'razorpay' ? { keyId: KEY_ID, orderId: o.rzpOrderId, amount: Math.round(o.total * 100) } : null
    });
  }

  let mt = p.match(/^\/api\/orders\/([\w-]{6,40})$/);
  if (m === 'GET' && mt) {
    const o = ownOrder(req, mt[1]);
    return sendJson(res, 200, { code: o.code, status: o.status, payment: o.payment, total: o.total, items: o.items });
  }
  mt = p.match(/^\/api\/orders\/([\w-]{6,40})\/verify$/);
  if (m === 'POST' && mt) {
    if (PAYMENT_MODE !== 'razorpay') throw new HttpError(404, 'Not found.');
    const o = ownOrder(req, mt[1]);
    const b = await readJson(req);
    if (o.payment === 'paid') return sendJson(res, 200, { ok: true, code: o.code });
    const pid = String(b.razorpay_payment_id || ''), oid = String(b.razorpay_order_id || ''), sig = String(b.razorpay_signature || '');
    if (!o.rzpOrderId || oid !== o.rzpOrderId) throw new HttpError(400, 'That payment does not match this order.');
    const expected = crypto.createHmac('sha256', KEY_SECRET).update(oid + '|' + pid).digest('hex');
    if (!safeEq(expected, sig)) throw new HttpError(400, 'We could not verify the payment. If money was deducted, show this screen to the staff.');
    markPaid(o, pid);
    return sendJson(res, 200, { ok: true, code: o.code });
  }
  mt = p.match(/^\/api\/orders\/([\w-]{6,40})\/test-pay$/);
  if (m === 'POST' && mt) {
    if (PAYMENT_MODE !== 'test') throw new HttpError(404, 'Not found.');
    const o = ownOrder(req, mt[1]);
    markPaid(o, 'test_' + rid());
    return sendJson(res, 200, { ok: true, code: o.code });
  }

  if (m === 'POST' && p === '/api/razorpay/webhook') {
    if (!WEBHOOK_SECRET) throw new HttpError(503, 'Webhook is not configured.');
    const raw = await readBody(req, 200000);
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    if (!safeEq(expected, req.headers['x-razorpay-signature'] || '')) throw new HttpError(400, 'Bad signature.');
    let ev;
    try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'Invalid JSON.'); }
    if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
      const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
      if (pay && pay.order_id) {
        const o = Object.values(orders).find(x => x.rzpOrderId === pay.order_id);
        if (o && pay.status === 'captured' && pay.currency === 'INR' && pay.amount === Math.round(o.total * 100)) markPaid(o, pay.id);
        else console.warn('Webhook payment ignored (unknown order or amount mismatch):', pay.id);
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (m === 'GET' && p === '/api/kitchen/orders') {
    if (!requireKitchen(req, res)) return;
    const list = Object.values(orders).filter(o => o.payment === 'paid').sort((a, b) => b.paidAt - a.paidAt).slice(0, 300).reverse();
    return sendJson(res, 200, { now: Date.now(), orders: list.map(kitchenView) });
  }
  mt = p.match(/^\/api\/kitchen\/orders\/([\w-]{6,40})\/status$/);
  if (m === 'POST' && mt) {
    if (!requireKitchen(req, res)) return;
    const o = orders[mt[1]];
    if (!o || o.payment !== 'paid') throw new HttpError(404, 'Order not found.');
    const b = await readJson(req);
    if (!(TRANSITIONS[o.status] || []).includes(b.status)) throw new HttpError(400, 'That change is not allowed from the current status.');
    o.status = b.status; o.updatedAt = Date.now(); save();
    return sendJson(res, 200, kitchenView(o));
  }
  throw new HttpError(404, 'Not found.');
}

const server = http.createServer(function (req, res) {
  route(req, res).catch(function (e) {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong.' });
  });
});
server.listen(PORT, function () {
  const kind = PAYMENT_MODE === 'test' ? 'TEST MODE, no real payments'
    : KEY_ID.startsWith('rzp_live_') ? 'Razorpay LIVE keys, real money'
    : KEY_ID.startsWith('rzp_test_') ? 'Razorpay TEST keys, no real money' : 'Razorpay keys';
  console.log("Mitki's Cafe is running on port " + PORT + ' (' + kind + ')');
  if (PAYMENT_MODE === 'razorpay' && !WEBHOOK_SECRET) console.warn('RAZORPAY_WEBHOOK_SECRET is not set. Paid orders will only appear if the customer\'s browser stays open until payment is confirmed.');
});
function shutdown() { try { flush(); } catch (e) { /* ignore */ } process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

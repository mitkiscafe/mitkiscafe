'use strict';
/*
 * End-to-end checks of the ordering server against a fake Razorpay.
 * Run: node tests/run-tests.js    (no internet or Razorpay account needed)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KEY_ID = 'rzp_test_abc123', KEY_SECRET = 'keysecret-for-tests', HOOK = 'hooksecret-for-tests', KPASS = 'kitchenpass1';
const basic = 'Basic ' + Buffer.from('staff:' + KPASS).toString('base64');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}
const freePort = () => new Promise(function (res) { const s = net.createServer(); s.listen(0, function () { const p = s.address().port; s.close(function () { res(p); }); }); });

/* ---- fake Razorpay ---- */
const rzpCalls = [];
let rzpFail = false;
const mock = http.createServer(function (req, res) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', function () {
    rzpCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
    if (rzpFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"description":"down"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'order_MOCK' + rzpCalls.length }));
  });
});

/* ---- start/stop the real server ---- */
function startServer(extraEnv, dataDir) {
  return new Promise(async function (resolve, reject) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({ PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir }, extraEnv), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('is running')) resolve({ child, base: 'http://127.0.0.1:' + port, out: () => out }); });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => { if (!out.includes('is running')) reject(new Error('exited with ' + code + ': ' + out.trim())); });
  });
}
const stop = s => new Promise(function (res) { s.child.once('exit', res); s.child.kill('SIGTERM'); });
function exitCode(env) {
  return new Promise(async function (res) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mitki-'));
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({ PATH: process.env.PATH, PORT: String(await freePort()), DATA_DIR: d }, env), stdio: 'ignore' });
    c.on('exit', code => res(code));
    setTimeout(() => { c.kill(); }, 3000);
  });
}

let ipN = 0;
function client(base) {
  return async function (method, url, o) {
    o = o || {};
    const headers = Object.assign({ 'x-forwarded-for': o.ip || 'test-ip-' + (++ipN) }, o.headers || {});
    let body;
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    if (o.raw !== undefined) body = o.raw;
    const r = await fetch(base + url, { method, headers, body });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: r.status, json, text };
  };
}
const sign = (orderId, paymentId, secret) => crypto.createHmac('sha256', secret || KEY_SECRET).update(orderId + '|' + paymentId).digest('hex');
const good = (extra) => Object.assign({ items: [{ id: 'masala', opt: 0, qty: 1 }], mode: 'Dine-in', name: 'Riya', table: '4', note: '' }, extra || {});

(async function main() {
  await new Promise(r => mock.listen(0, r));
  const mockUrl = 'http://127.0.0.1:' + mock.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitki-'));
  const env = { PAYMENT_MODE: 'razorpay', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK, KITCHEN_PASSWORD: KPASS, RAZORPAY_API_BASE: mockUrl };
  let s = await startServer(env, dataDir);
  let api = client(s.base);
  const kitchen = () => api('GET', '/api/kitchen/orders', { headers: { Authorization: basic } });

  console.log('Ordering and pricing');
  await test('menu loads and reports razorpay mode', async function () {
    const r = await api('GET', '/api/menu');
    assert.equal(r.status, 200); assert.equal(r.json.paymentMode, 'razorpay'); assert.ok(r.json.items.length > 20);
  });
  let o1;
  await test('server prices the order itself and charges that amount in paise', async function () {
    const r = await api('POST', '/api/orders', { json: { items: [{ id: 'special', opt: 1, qty: 2, price: 1 }, { id: 'chicken65', qty: 1, price: 1 }], total: 1, mode: 'Dine-in', name: ' Riya ', table: '4', note: 'less sugar' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.total, 190);
    assert.equal(r.json.razorpay.amount, 19000);
    assert.match(r.json.code, /^[A-Z2-9]{4,6}$/);
    const call = rzpCalls[rzpCalls.length - 1];
    assert.equal(call.url, '/v1/orders'); assert.equal(call.body.amount, 19000); assert.equal(call.body.currency, 'INR');
    assert.equal(call.auth, 'Basic ' + Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64'));
    assert.equal(JSON.stringify(r.json).includes(KEY_SECRET), false);
    o1 = r.json;
  });
  await test('rejects upcoming items, bad quantities, bad options, empty name, bad mode', async function () {
    const bad = [
      good({ items: [{ id: 'hotchoc', qty: 1 }] }), good({ items: [{ id: 'masala', qty: 0 }] }), good({ items: [{ id: 'masala', qty: 21 }] }),
      good({ items: [{ id: 'masala', opt: 5, qty: 1 }] }), good({ items: [{ id: 'nope', qty: 1 }] }), good({ items: [] }),
      good({ name: '   ' }), good({ mode: 'Delivery' }), good({ items: [{ id: 'masala', qty: 1 }, { id: 'masala', qty: 1 }] })
    ];
    for (const b of bad) { const r = await api('POST', '/api/orders', { json: b }); assert.equal(r.status, 400, JSON.stringify(b)); }
  });
  await test('rejects non-JSON bodies and cross-site requests', async function () {
    assert.equal((await api('POST', '/api/orders', { raw: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await api('POST', '/api/orders', { json: good(), headers: { Origin: 'https://evil.example' } })).status, 403);
  });
  await test('payment system down gives a clean error and leaves no order behind', async function () {
    rzpFail = true;
    const r = await api('POST', '/api/orders', { json: good() });
    rzpFail = false;
    assert.equal(r.status, 502);
  });
  await test('rate limit stops order spam from one address', async function () {
    let last;
    for (let i = 0; i < 17; i++) last = await api('POST', '/api/orders', { ip: 'spammer', json: good({ items: [{ id: 'hotchoc', qty: 1 }] }) });
    assert.equal(last.status, 429);
  });

  console.log('Kitchen access');
  await test('kitchen needs the password', async function () {
    assert.equal((await api('GET', '/kitchen')).status, 401);
    assert.equal((await api('GET', '/api/kitchen/orders')).status, 401);
    assert.equal((await api('GET', '/api/kitchen/orders', { headers: { Authorization: 'Basic ' + Buffer.from('staff:wrong').toString('base64') } })).status, 401);
    const ok = await api('GET', '/kitchen', { headers: { Authorization: basic } });
    assert.equal(ok.status, 200); assert.ok(ok.text.includes('Kitchen'));
  });
  await test('kitchen script is not public', async function () { assert.equal((await api('GET', '/kitchen.js')).status, 401); });
  await test('unpaid orders do not show on the kitchen screen', async function () {
    const r = await kitchen(); assert.equal(r.status, 200); assert.equal(r.json.orders.length, 0);
  });

  console.log('Paying');
  await test('wrong signature is refused, order stays unpaid', async function () {
    const r = await api('POST', '/api/orders/' + o1.id + '/verify', { headers: { 'X-Order-Token': o1.token }, json: { razorpay_payment_id: 'pay_1', razorpay_order_id: o1.razorpay.orderId, razorpay_signature: sign(o1.razorpay.orderId, 'pay_1', 'other-secret') } });
    assert.equal(r.status, 400);
    assert.equal((await kitchen()).json.orders.length, 0);
  });
  await test('signature for a different order id is refused', async function () {
    const r = await api('POST', '/api/orders/' + o1.id + '/verify', { headers: { 'X-Order-Token': o1.token }, json: { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_OTHER', razorpay_signature: sign('order_OTHER', 'pay_1') } });
    assert.equal(r.status, 400);
  });
  await test('someone without the order token cannot verify or read it', async function () {
    const body = { razorpay_payment_id: 'pay_1', razorpay_order_id: o1.razorpay.orderId, razorpay_signature: sign(o1.razorpay.orderId, 'pay_1') };
    assert.equal((await api('POST', '/api/orders/' + o1.id + '/verify', { json: body })).status, 404);
    assert.equal((await api('POST', '/api/orders/' + o1.id + '/verify', { headers: { 'X-Order-Token': 'wrong-token' }, json: body })).status, 404);
    assert.equal((await api('GET', '/api/orders/' + o1.id)).status, 404);
  });
  await test('correct signature marks the order paid and it reaches the kitchen', async function () {
    const r = await api('POST', '/api/orders/' + o1.id + '/verify', { headers: { 'X-Order-Token': o1.token }, json: { razorpay_payment_id: 'pay_REAL1', razorpay_order_id: o1.razorpay.orderId, razorpay_signature: sign(o1.razorpay.orderId, 'pay_REAL1') } });
    assert.equal(r.status, 200);
    const k = (await kitchen()).json.orders;
    assert.equal(k.length, 1);
    assert.equal(k[0].code, o1.code); assert.equal(k[0].status, 'new'); assert.equal(k[0].paymentId, 'pay_REAL1'); assert.equal(k[0].total, 190);
    assert.equal(k[0].token, undefined);
    assert.deepEqual(k[0].items.map(i => i.name), ['Mitki\'s Special Chai (Kulhad)', 'Chicken 65 (6 pc)']);
  });
  await test('verifying twice does nothing extra', async function () {
    const r = await api('POST', '/api/orders/' + o1.id + '/verify', { headers: { 'X-Order-Token': o1.token }, json: { razorpay_payment_id: 'pay_REAL1', razorpay_order_id: o1.razorpay.orderId, razorpay_signature: sign(o1.razorpay.orderId, 'pay_REAL1') } });
    assert.equal(r.status, 200); assert.equal((await kitchen()).json.orders.length, 1);
  });
  await test('customer can follow their own order status', async function () {
    const r = await api('GET', '/api/orders/' + o1.id, { headers: { 'X-Order-Token': o1.token } });
    assert.equal(r.status, 200); assert.equal(r.json.payment, 'paid'); assert.equal(r.json.status, 'new');
  });
  await test('test-pay is not available in razorpay mode', async function () {
    const r = await api('POST', '/api/orders/' + o1.id + '/test-pay', { headers: { 'X-Order-Token': o1.token }, json: {} });
    assert.equal(r.status, 404);
  });

  console.log('Webhook (customer closes the page before confirming)');
  let o2, o3;
  const hook = (payload, secret) => { const raw = JSON.stringify(payload); return api('POST', '/api/razorpay/webhook', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': crypto.createHmac('sha256', secret || HOOK).update(raw).digest('hex') } }); };
  const captured = (orderId, amount, id) => ({ event: 'payment.captured', payload: { payment: { entity: { id: id || 'pay_HOOK', order_id: orderId, amount, currency: 'INR', status: 'captured' } } } });
  await test('webhook with a bad signature is refused', async function () {
    o2 = (await api('POST', '/api/orders', { json: good({ items: [{ id: 'bun', qty: 2 }] }) })).json;
    const r = await hook(captured(o2.razorpay.orderId, 5000), 'wrong-secret');
    assert.equal(r.status, 400); assert.equal((await kitchen()).json.orders.length, 1);
  });
  await test('webhook with the wrong amount is ignored', async function () {
    const r = await hook(captured(o2.razorpay.orderId, 100)); assert.equal(r.status, 200);
    assert.equal((await kitchen()).json.orders.length, 1);
  });
  await test('valid webhook marks the order paid', async function () {
    const r = await hook(captured(o2.razorpay.orderId, 5000, 'pay_HOOK2')); assert.equal(r.status, 200);
    const k = (await kitchen()).json.orders; assert.equal(k.length, 2);
    assert.equal(k.find(o => o.code === o2.code).paymentId, 'pay_HOOK2');
  });
  await test('webhook for an unknown order is accepted and ignored', async function () {
    assert.equal((await hook(captured('order_UNKNOWN', 5000))).status, 200); assert.equal((await kitchen()).json.orders.length, 2);
  });

  console.log('Kitchen actions');
  await test('status moves new > preparing > ready > served, and skipping steps is refused', async function () {
    const id = (await kitchen()).json.orders.find(o => o.code === o1.code).id;
    const set = st => api('POST', '/api/kitchen/orders/' + id + '/status', { headers: { Authorization: basic }, json: { status: st } });
    assert.equal((await set('served')).status, 400);
    assert.equal((await set('preparing')).json.status, 'preparing');
    assert.equal((await set('ready')).json.status, 'ready');
    assert.equal((await set('served')).json.status, 'served');
    assert.equal((await set('new')).json.status, 'new');
    assert.equal((await set('cancelled')).json.status, 'cancelled');
    const cust = await api('GET', '/api/orders/' + o1.id, { headers: { 'X-Order-Token': o1.token } });
    assert.equal(cust.json.status, 'cancelled');
  });
  await test('status changes need the kitchen password and a JSON body', async function () {
    const id = (await kitchen()).json.orders[0].id;
    assert.equal((await api('POST', '/api/kitchen/orders/' + id + '/status', { json: { status: 'preparing' } })).status, 401);
    assert.equal((await api('POST', '/api/kitchen/orders/' + id + '/status', { headers: { Authorization: basic, Origin: 'https://evil.example' }, json: { status: 'preparing' } })).status, 403);
  });
  await test('unpaid orders cannot be changed from the kitchen', async function () {
    o3 = (await api('POST', '/api/orders', { json: good() })).json;
    const r = await api('POST', '/api/kitchen/orders/' + o3.id + '/status', { headers: { Authorization: basic }, json: { status: 'preparing' } });
    assert.equal(r.status, 404);
  });

  console.log('Restart');
  await test('paid orders survive a restart', async function () {
    await stop(s);
    s = await startServer(env, dataDir); api = client(s.base);
    const k = (await kitchen()).json.orders;
    assert.equal(k.length, 2);
    assert.ok(k.some(o => o.code === o1.code) && k.some(o => o.code === o2.code));
  });
  await stop(s);

  console.log('Trial (test) mode and start-up safety');
  await test('test mode takes no gateway and marks paid on test-pay', async function () {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mitki-'));
    const t = await startServer({ PAYMENT_MODE: 'test', KITCHEN_PASSWORD: KPASS }, d);
    const c = client(t.base);
    const r = await c('POST', '/api/orders', { json: good() });
    assert.equal(r.status, 201); assert.equal(r.json.razorpay, null);
    assert.equal((await c('POST', '/api/orders/' + r.json.id + '/verify', { headers: { 'X-Order-Token': r.json.token }, json: {} })).status, 404);
    assert.equal((await c('POST', '/api/orders/' + r.json.id + '/test-pay', { headers: { 'X-Order-Token': r.json.token }, json: {} })).status, 200);
    const k = await c('GET', '/api/kitchen/orders', { headers: { Authorization: basic } });
    assert.equal(k.json.orders.length, 1);
    assert.equal((await c('GET', '/api/menu')).json.paymentMode, 'test');
    await stop(t);
  });
  await test('server refuses to start without a kitchen password, without keys, or in test mode in production', async function () {
    assert.notEqual(await exitCode({ PAYMENT_MODE: 'test' }), 0);
    assert.notEqual(await exitCode({ PAYMENT_MODE: 'razorpay', KITCHEN_PASSWORD: KPASS }), 0);
    assert.notEqual(await exitCode({ PAYMENT_MODE: 'test', KITCHEN_PASSWORD: KPASS, NODE_ENV: 'production' }), 0);
    assert.notEqual(await exitCode({ PAYMENT_MODE: 'test', KITCHEN_PASSWORD: 'short' }), 0);
  });

  mock.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();

(function () {
  'use strict';
  var menu = null, byId = {}, cart = {}, sel = {};
  var activeCat = 'All', paymentMode = 'razorpay', busy = false, pollTimer = null, finishing = false;
  var CART_KEY = 'mitkis-cart-v3', LAST_KEY = 'mitkis-last';
  var $ = function (id) { return document.getElementById(id); };
  var rupee = function (n) { return '₹' + n.toLocaleString('en-IN'); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function say(t) { $('status').textContent = t || ''; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }

  function api(method, url, body, token) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['X-Order-Token'] = token;
    return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  /* ---- menu and cart ---- */
  function keyOf(item, idx) { return item.options && item.options.length ? item.id + '~' + idx : item.id; }
  function info(key) {
    var p = String(key).split('~'), it = byId[p[0]];
    if (!it || it.price == null) return null;
    var idx = 0, extra = 0, name = it.name;
    if (it.options && it.options.length) {
      idx = p.length > 1 ? parseInt(p[1], 10) : 0;
      if (!(idx >= 0 && idx < it.options.length)) return null;
      extra = it.options[idx].extra || 0;
      name += ' (' + it.options[idx].label + ')';
    } else if (p.length > 1) return null;
    return { item: it, idx: idx, name: name, price: it.price + extra };
  }
  function mark(veg) { return '<span class="vm ' + (veg ? 'veg' : 'nonveg') + '" role="img" aria-label="' + (veg ? 'Vegetarian' : 'Non-vegetarian') + '"></span>'; }
  function stepper(key) {
    var q = cart[key] || 0, nm = esc(info(key).name);
    if (!q) return '<button class="add" type="button" data-act="inc" data-id="' + key + '" aria-label="Add ' + nm + '">Add</button>';
    return '<div class="step"><button type="button" data-act="dec" data-id="' + key + '" aria-label="Remove one ' + nm + '">−</button>' +
      '<span aria-label="' + q + ' in order">' + q + '</span>' +
      '<button type="button" data-act="inc" data-id="' + key + '" aria-label="Add one ' + nm + '">+</button></div>';
  }
  function rowInner(m) {
    var idx = sel[m.id] || 0, orderable = m.price != null, key = orderable ? keyOf(m, idx) : null, opts = '';
    if (orderable && m.options && m.options.length) {
      opts = '<div class="opts" role="group" aria-label="Options for ' + esc(m.name) + '">' + m.options.map(function (o, i) {
        return '<button class="opt" type="button" data-opt="' + m.id + '" data-idx="' + i + '" aria-pressed="' + (i === idx) + '">' + esc(o.label) + (o.extra ? ' +' + rupee(o.extra) : '') + '</button>';
      }).join('') + '</div>';
    }
    return '<div><div class="nm">' + mark(m.veg) + esc(m.name) + '</div>' + opts + '</div>' +
      '<div class="side">' + (orderable ? '<span class="pr">' + rupee(info(key).price) + '</span>' + stepper(key) : '<span class="ask">Upcoming</span>') + '</div>';
  }
  function updateRow(id) { var li = $('row-' + id); if (li) li.innerHTML = rowInner(byId[id]); }
  function renderChips() {
    var all = ['All'].concat(menu.categories.map(function (c) { return c.name; }));
    $('chips').innerHTML = all.map(function (c) {
      return '<button class="chip" type="button" data-cat="' + esc(c) + '" aria-pressed="' + (c === activeCat) + '">' + esc(c) + '</button>';
    }).join('');
  }
  function renderMenu() {
    var vegOnly = $('vegOnly').checked, html = '';
    menu.categories.forEach(function (c) {
      if (activeCat !== 'All' && activeCat !== c.name) return;
      var items = menu.items.filter(function (m) { return m.cat === c.name && (!vegOnly || m.veg); });
      if (!items.length) return;
      html += '<section class="cat"><h2>' + esc(c.name) + '</h2><ul class="items">' +
        items.map(function (m) { return '<li class="item" id="row-' + m.id + '">' + rowInner(m) + '</li>'; }).join('') + '</ul></section>';
    });
    $('menu').innerHTML = html || '<p class="empty-menu">Nothing in this section matches. Try turning off the veg filter.</p>';
  }
  function totals() {
    var n = 0, t = 0;
    Object.keys(cart).forEach(function (k) { n += cart[k]; t += cart[k] * info(k).price; });
    return { n: n, t: t };
  }
  function formValues() {
    return { mode: document.querySelector('input[name="mode"]:checked').value, name: $('custName').value.trim(), table: $('tableNo').value.trim(), note: $('note').value.trim() };
  }
  function renderCart() {
    var keys = Object.keys(cart), tt = totals();
    $('lines').innerHTML = keys.length ? keys.map(function (k) {
      var i = info(k);
      return '<li class="line"><span class="n">' + esc(i.name) + '</span><span class="t">' + rupee(cart[k] * i.price) + '</span>' + stepper(k) + '</li>';
    }).join('') : '<li class="none">Nothing here yet. Add something from the menu.</li>';
    $('total').textContent = rupee(tt.t);
    var showBar = tt.n > 0 && !$('checkout').hidden;
    $('bar').hidden = !showBar;
    document.body.classList.toggle('has-bar', showBar);
    $('barText').textContent = tt.n + (tt.n === 1 ? ' item · ' : ' items · ') + rupee(tt.t);
    var label = paymentMode === 'test' ? 'Place test order' : 'Pay';
    $('pay').textContent = busy ? 'Please wait…' : (tt.n ? label + ' · ' + rupee(tt.t) : label);
    $('pay').disabled = !tt.n || busy;
  }
  function setBusy(b) { busy = b; renderCart(); }

  /* ---- paying ---- */
  function startPay() {
    if (busy) return;
    var tt = totals();
    if (!tt.n) return;
    var f = formValues();
    if (!f.name) { say('Please enter your name so we can call you.'); $('custName').focus(); return; }
    setBusy(true); say(''); finishing = false;
    var items = Object.keys(cart).map(function (k) {
      var i = info(k);
      var line = { id: i.item.id, qty: cart[k] };
      if (i.item.options && i.item.options.length) line.opt = i.idx;
      return line;
    });
    api('POST', '/api/orders', { items: items, mode: f.mode, name: f.name, table: f.table, note: f.note }).then(function (o) {
      if (o.paymentMode === 'test') {
        return api('POST', '/api/orders/' + o.id + '/test-pay', {}, o.token).then(function () { placed(o); });
      }
      openCheckout(o, f);
    }).catch(function (e) { setBusy(false); say(e.message); });
  }
  function openCheckout(o, f) {
    if (!window.Razorpay) { setBusy(false); say('The payment window could not load. Check your connection and try again.'); return; }
    var rz = new window.Razorpay({
      key: o.razorpay.keyId, amount: o.razorpay.amount, currency: 'INR', name: "Mitki's Cafe",
      description: 'Order #' + o.code, order_id: o.razorpay.orderId, prefill: { name: f.name }, theme: { color: '#FFB400' },
      handler: function (r) { finishing = true; confirmPayment(o, r); },
      modal: { ondismiss: function () { if (!finishing) { setBusy(false); say('Payment was not completed, so your order was not placed.'); } } }
    });
    rz.on('payment.failed', function (resp) {
      say('Payment failed' + (resp && resp.error && resp.error.description ? ': ' + resp.error.description : '') + '. You can try again.');
    });
    rz.open();
  }
  function confirmPayment(o, r) {
    say('Confirming your payment…');
    api('POST', '/api/orders/' + o.id + '/verify', {
      razorpay_payment_id: r.razorpay_payment_id, razorpay_order_id: r.razorpay_order_id, razorpay_signature: r.razorpay_signature
    }, o.token).then(function () { placed(o); }).catch(function (e) {
      // The payment may still be confirmed by the gateway's webhook, so keep tracking this order.
      placed(o, "We're still confirming your payment. Keep this number. If it does not change in a minute, show it to the staff.");
      say(e.message);
    });
  }
  function placed(o, note) {
    cart = {}; store(CART_KEY, cart);
    busy = false;
    store(LAST_KEY, { id: o.id, token: o.token, code: o.code, at: Date.now() });
    showTrack(o.code, note || 'Payment received. Your order is with the kitchen.');
    renderMenu(); $('note').value = ''; renderCart();
    poll();
  }

  /* ---- order tracking ---- */
  function showTrack(code, text, done) {
    $('track').hidden = false; $('checkout').hidden = true;
    $('trackCode').textContent = '#' + code;
    $('trackState').textContent = text;
    $('newOrder').hidden = !done;
    renderCart();
    $('track').scrollIntoView({ block: 'nearest' });
  }
  var STATE_TEXT = {
    new: 'Order received. We will start on it shortly.',
    preparing: 'Your order is being prepared.',
    ready: 'Your order is ready. Please collect it at the counter.',
    served: 'Served. Enjoy!',
    cancelled: 'This order was cancelled. If you were charged, ask the staff for a refund.'
  };
  function poll() {
    clearTimeout(pollTimer);
    var last = load(LAST_KEY);
    if (!last) return;
    api('GET', '/api/orders/' + last.id, null, last.token).then(function (s) {
      var done = s.status === 'served' || s.status === 'cancelled';
      var text = s.payment !== 'paid' ? "We're still confirming your payment. Keep this number. If it does not change in a minute, show it to the staff." : STATE_TEXT[s.status] || '';
      showTrack(s.code, text, done);
      if (!done) pollTimer = setTimeout(poll, 6000);
    }).catch(function (e) {
      if (e.status === 404) { store(LAST_KEY, null); resetToMenu(); return; }
      pollTimer = setTimeout(poll, 10000);
    });
  }
  function resetToMenu() {
    clearTimeout(pollTimer);
    $('track').hidden = true; $('checkout').hidden = false; say('');
    renderCart();
  }

  /* ---- events ---- */
  document.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) { activeCat = chip.getAttribute('data-cat'); renderChips(); renderMenu(); return; }
    var op = e.target.closest('[data-opt]');
    if (op) {
      var mid = op.getAttribute('data-opt'), ix = parseInt(op.getAttribute('data-idx'), 10);
      sel[mid] = ix; updateRow(mid);
      var again = $('row-' + mid).querySelector('[data-opt="' + mid + '"][data-idx="' + ix + '"]');
      if (again) again.focus();
      return;
    }
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var key = b.getAttribute('data-id'), a = b.getAttribute('data-act');
    if (!info(key) || busy) return;
    var inCart = !!b.closest('#cart');
    var q = Math.max(0, Math.min(20, (cart[key] || 0) + (a === 'inc' ? 1 : -1)));
    if (q) cart[key] = q; else delete cart[key];
    store(CART_KEY, cart);
    updateRow(info(key).item.id);
    renderCart();
    var scope = inCart ? $('cart') : $('menu');
    var next = scope.querySelector('[data-act="' + a + '"][data-id="' + key + '"]') || scope.querySelector('[data-act="inc"][data-id="' + key + '"]');
    if (next) next.focus();
  });
  $('vegOnly').addEventListener('change', renderMenu);
  document.querySelectorAll('input[name="mode"]').forEach(function (r) {
    r.addEventListener('change', function () { $('tableWrap').hidden = formValues().mode !== 'Dine-in'; });
  });
  $('bar').addEventListener('click', function () { $('cart').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('pay').addEventListener('click', startPay);
  $('newOrder').addEventListener('click', function () { store(LAST_KEY, null); resetToMenu(); });

  /* ---- start ---- */
  fetch('/api/menu').then(function (r) { return r.json(); }).then(function (m) {
    menu = m; paymentMode = m.paymentMode;
    m.items.forEach(function (it) { byId[it.id] = it; });
    var saved = load(CART_KEY) || {};
    Object.keys(saved).forEach(function (k) { if (info(k) && saved[k] > 0) cart[k] = Math.min(20, saved[k] | 0); });
    $('testBanner').hidden = paymentMode !== 'test';
    renderChips(); renderMenu(); renderCart();
    var last = load(LAST_KEY);
    if (last && Date.now() - last.at < 6 * 36e5) poll(); else store(LAST_KEY, null);
  }).catch(function () {
    $('menu').innerHTML = '<p class="empty-menu">The menu could not load. Check your connection and reload the page.</p>';
  });
})();

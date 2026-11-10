(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var rupee = function (n) { return '₹' + n.toLocaleString('en-IN'); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var orders = [], known = null, pending = {}, armed = null, soundOn = false, ctx = null, loaded = false, failed = false;
  var NEXT = { 'new': ['preparing', 'Start preparing'], preparing: ['ready', 'Mark ready'], ready: ['served', 'Mark served'] };
  var COLS = [['new', 'New'], ['preparing', 'Preparing'], ['ready', 'Ready']];

  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ' + (m % 60) + ' min ago';
    return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function card(o) {
    var items = o.items.map(function (i) {
      return '<li><span>' + esc(i.qty) + ' × ' + esc(i.name) + '</span><span>' + rupee(i.qty * i.price) + '</span></li>';
    }).join('');
    var meta = esc(o.mode) + (o.table ? ' · Table ' + esc(o.table) : '') + ' · ' + esc(o.name);
    var busy = pending[o.id] ? ' disabled' : '';
    var btns = '';
    if (NEXT[o.status]) {
      btns = '<button class="sbtn" type="button" data-act="advance" data-id="' + esc(o.id) + '"' + busy + '>' + NEXT[o.status][1] + '</button>' +
        '<button class="sbtn quiet" type="button" data-act="cancel" data-id="' + esc(o.id) + '"' + busy + '>' + (armed === o.id ? 'Tap again to cancel' : 'Cancel') + '</button>';
    } else {
      btns = '<span class="pill ' + esc(o.status) + '">' + (o.status === 'cancelled' ? 'Cancelled' : 'Served') + '</span>' +
        '<button class="sbtn quiet" type="button" data-act="reopen" data-id="' + esc(o.id) + '"' + busy + '>Reopen</button>';
    }
    return '<article class="ocard"><header><span class="code">#' + esc(o.code) + '</span><span class="when">' + ago(o.paidAt) + '</span></header>' +
      '<p class="meta">' + meta + '</p><ul>' + items + '</ul>' +
      (o.note ? '<p class="onote">' + esc(o.note) + '</p>' : '') +
      '<footer><span class="sum">' + rupee(o.total) + ' paid</span><div class="obtns">' + btns + '</div></footer>' +
      '<p class="pid">Payment ' + esc(o.paymentId || '') + '</p></article>';
  }

  function render() {
    var active = orders.filter(function (o) { return NEXT[o.status]; });
    var note = $('boardNote');
    if (failed) note.textContent = 'Cannot reach the server. Showing the last orders received. Retrying…';
    else if (!loaded) note.textContent = 'Loading orders…';
    else note.textContent = active.length ? active.length + (active.length === 1 ? ' order' : ' orders') + ' in progress' : 'Nothing in progress. New paid orders appear here.';
    document.title = (active.filter(function (o) { return o.status === 'new'; }).length ? '(' + active.filter(function (o) { return o.status === 'new'; }).length + ') ' : '') + 'Kitchen · Mitki\'s Cafe';

    $('board').innerHTML = COLS.map(function (c) {
      var list = active.filter(function (o) { return o.status === c[0]; }).sort(function (a, b) { return a.paidAt - b.paidAt; });
      return '<section class="col"><h3>' + c[1] + ' <span class="badge">' + list.length + '</span></h3><div class="list">' +
        (list.length ? list.map(card).join('') : '<p class="blank">Nothing here.</p>') + '</div></section>';
    }).join('');

    var done = orders.filter(function (o) { return !NEXT[o.status]; }).sort(function (a, b) { return b.updatedAt - a.updatedAt; }).slice(0, 24);
    $('doneWrap').hidden = !done.length;
    $('doneSum').textContent = 'Served and cancelled (' + done.length + ')';
    $('doneList').innerHTML = done.map(card).join('');
  }

  function beep() {
    if (!soundOn || !ctx) return;
    [0, 0.22].forEach(function (t) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.18);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
    });
  }

  function refresh() {
    fetch('/api/kitchen/orders', { cache: 'no-store' }).then(function (r) {
      if (r.status === 401) { $('boardNote').textContent = 'Signed out. Reload the page to sign in again.'; throw new Error('auth'); }
      if (!r.ok) throw new Error('http');
      return r.json();
    }).then(function (j) {
      failed = false; loaded = true;
      orders = j.orders;
      var ids = {};
      orders.forEach(function (o) { ids[o.id] = true; });
      if (known) {
        var fresh = orders.filter(function (o) { return !known[o.id] && o.status === 'new'; });
        if (fresh.length) beep();
      }
      known = ids;
      render();
    }).catch(function (e) {
      if (e.message === 'auth') return;
      failed = true; render();
    });
  }

  function change(id, status) {
    if (pending[id]) return;
    pending[id] = true; render();
    fetch('/api/kitchen/orders/' + encodeURIComponent(id) + '/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status })
    }).then(function (r) {
      if (!r.ok) throw new Error('http');
      return r.json();
    }).then(function (o) {
      orders = orders.map(function (x) { return x.id === o.id ? o : x; });
    }).catch(function () {
      $('boardNote').textContent = 'That change did not save. Check your connection and try again.';
    }).then(function () { delete pending[id]; render(); });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    var o = orders.filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    if (act === 'advance' && NEXT[o.status]) change(id, NEXT[o.status][0]);
    else if (act === 'reopen') change(id, 'new');
    else if (act === 'cancel') {
      if (armed === id) { armed = null; change(id, 'cancelled'); }
      else { armed = id; render(); setTimeout(function () { if (armed === id) { armed = null; render(); } }, 4000); }
    }
  });
  $('sound').addEventListener('click', function () {
    soundOn = !soundOn;
    if (soundOn) { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); beep(); } catch (e) { soundOn = false; } }
    $('sound').setAttribute('aria-pressed', String(soundOn));
    $('sound').textContent = soundOn ? 'Sound on' : 'Sound off';
  });

  refresh();
  setInterval(refresh, 4000);
  setInterval(function () { if (loaded) render(); }, 30000);
})();

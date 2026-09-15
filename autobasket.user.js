// ==UserScript==
// @name         NFF resale auto-basket
// @namespace    https://github.com/Mikkelnaes/nff-resale-watch
// @version      0.1.1
// @description  When the nff-resale-watch cloud watcher reports Norway-Denmark / Norway-Portugal resale tickets, reserve adjacent seats in this browser's basket and raise the alarm.
// @match        https://resale.fotball.no/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  How it works (design: docs/superpowers/specs/2026-09-15-auto-basket-design.md)

  - Runs in a resale.fotball.no tab where you are logged in. It never polls the shop.
  - It subscribes to your ntfy topic's event stream. When the cloud watcher publishes
    "TICKETS LISTED on NFF resale!" it reads the per-match items JSON once (the same
    request the match page makes), picks adjacent seats (4 preferred, else 2, never 1 or
    3: same section, same row, seat numbers 1 apart) and sends the shop's own
    add-to-basket request from this session. Then: alarm, phone push, basket page.
  - Anything else (refusal, waiting room, captcha, no seat numbers, request format not
    recognised): alarm, phone push with the reason, and the match page is opened so you
    are one click away. Nothing is retried blindly and nothing bypasses a captcha.
  - Settings live in localStorage (topic, armed/dry-run, keepalive). The overlay in the
    bottom-right corner shows the state and has the buttons.

  The pure decision logic is exported for `node test_autobasket.js`.
*/
(function (root) {
  'use strict';

  var AB = {
    VERSION: '0.1.1',
    MATCHES: { '10229739913106': 'Denmark', '10229739913107': 'Portugal' },
    WANT: [4, 2],                 // 4 first (two adjacent pairs), else 2 (one pair); never 1 or 3
    ADJACENT_STEP: 1,             // seat numbers this far apart count as neighbours
    EXCLUDE_AREA: null,           // e.g. /^(107|108|109|110|111|112)$/ to skip the away blocks; null = any section
    COOLDOWN_MS: 20 * 60 * 1000,  // after a reservation: ignore further alerts this long (basket hold ~15 min)
    PAUSE_MS: 3 * 60 * 1000,      // after a failure: leave the page alone while you work by hand
    STALE_MS: 2 * 60 * 1000,      // alerts older than this are ignored
    KEEPALIVE_MS: 10 * 60 * 1000, // one light request so the login does not time out (not listing polling)
    ALARM_SECONDS: 2,             // short beep sequence
    ALARM_GAIN: 0.08,             // quiet (0..1)
    FLASH_SECONDS: 10,            // tab title flashes this long (silent)
    ALERT_TITLE_RESALE: 'TICKETS LISTED on NFF resale!',
    ALERT_TITLE_SHOP: 'TICKETS ON SALE at billett.fotball.no!',
    OWN_TITLE_PREFIX: 'Auto-basket',
    SUBMIT_PATH: '/ajax/selection/resale/item/submit',   // cached-mode ajax variant
    FORM_SUBMIT_PATH: '/selection/resale/item/submit',    // the form action on the real match page (15 Sep)
    ITEMS_PATH: '/selection/resale/resaleItems.json',
    BASKET_PATH: '/cart/shoppingCart?lang=en',
    KEEPALIVE_PATH: '/cartData.json?lang=en',
    SHOP_PAGE: 'https://billett.fotball.no/selection/event/date?productId=10229739619905&lang=en'
  };
  AB.matchPage = function (id) {
    return '/selection/resale/item?performanceId=' + id + '&checkResaleAvailability=true&lang=en';
  };

  // ---- helpers -------------------------------------------------------------------
  function pick(obj, paths) {  // first defined value under any of the dotted paths
    if (!obj) return undefined;
    for (var i = 0; i < paths.length; i++) {
      var cur = obj, parts = paths[i].split('.');
      for (var j = 0; j < parts.length && cur !== null && cur !== undefined; j++) cur = cur[parts[j]];
      if (cur !== undefined && cur !== null && cur !== '') return cur;
    }
    return undefined;
  }
  function num(v) {
    if (v === undefined || v === null) return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  function trailingInt(s) { var m = /(\d+)\s*$/.exec(String(s)); return m ? Number(m[1]) : null; }
  function str(v) { return v === undefined || v === null ? null : String(v).trim(); }

  // ---- alert parsing -------------------------------------------------------------
  // ntfy message -> {kind:'resale', counts:{Denmark:2,...}} | {kind:'shop'} | null
  AB.parseAlert = function (msg) {
    if (!msg || (msg.event && msg.event !== 'message')) return null;
    var title = msg.title || '';
    if (title.indexOf(AB.OWN_TITLE_PREFIX) === 0) return null;
    if (title === AB.ALERT_TITLE_SHOP) return { kind: 'shop', counts: {} };
    if (title !== AB.ALERT_TITLE_RESALE) return null;
    var counts = {}, re = /([A-Za-z]+): (\d+) tickets?/g, m;
    while ((m = re.exec(msg.message || ''))) counts[m[1]] = Number(m[2]);
    return { kind: 'resale', counts: counts };
  };

  // ---- item normalisation --------------------------------------------------------
  // The real field names of resaleItems.json are confirmed from the first live capture
  // (evidence artifact); until then several candidates are accepted for every field.
  // Real 15 Sep capture: seat location is not in dedicated fields; the section is
  // `block` ("124") / `seatArea` ("KIWI-Bama-svingen") and row+seat are in
  // `remark` ("5 - 844" = row 5, seat 844). Explicit fields and a seatPath are still
  // accepted first so synthetic fixtures and any future shape keep working.
  AB.parsePlace = function (item) {
    var area = pick(item, ['block', 'seatArea', 'area', 'areaName', 'section', 'sectionName', 'blockName', 'zone', 'zoneName', 'area.name']);
    var row = pick(item, ['row', 'rowName', 'rowNumber', 'rowLabel', 'row.name']);
    var seat = pick(item, ['seat', 'seatNumber', 'seatName', 'seatLabel', 'number', 'seat.number']);
    if (row === undefined || seat === undefined) {
      var remark = pick(item, ['remark']);
      if (typeof remark === 'string' && remark.indexOf('-') >= 0) {
        var rs = remark.split('-');
        if (row === undefined) row = rs[0].trim();
        if (seat === undefined) seat = rs.slice(1).join('-').trim();
      }
    }
    if (area === undefined || row === undefined || seat === undefined) {
      var path = pick(item, ['seatPath', 'seatDescription', 'seatLabelPath', 'placeDescription']);
      if (typeof path === 'string') {
        var segs = path.split(/\s*[\/|>,;-]\s*/).filter(Boolean);
        if (segs.length >= 3) {
          if (seat === undefined) seat = segs[segs.length - 1];
          if (row === undefined) row = segs[segs.length - 2];
          if (area === undefined) area = segs.slice(0, segs.length - 2).join(' ');
        }
      }
    }
    return { area: str(area), row: str(row), seatNo: seat === undefined ? null : trailingInt(seat), seatLabel: str(seat) };
  };

  AB.normalizeItems = function (raw) {
    var list = (raw && (raw.resaleItems || raw.items)) || (Array.isArray(raw) ? raw : []);
    return list.filter(function (it) { return it && typeof it === 'object'; }).map(function (it) {
      var mids = pick(it, ['movementIds', 'ticketIds']);
      if (!Array.isArray(mids)) {
        var single = pick(it, ['movementId', 'ticketId']);
        if (single !== undefined) mids = [single];
        else if (Array.isArray(it.movements)) {
          mids = it.movements.map(function (m) { return m && typeof m === 'object' ? pick(m, ['movementId', 'id']) : m; })
                             .filter(function (x) { return x !== undefined; });
        } else {
          var fb = pick(it, ['itemId', 'id']);
          mids = fb === undefined ? [] : [fb];
        }
      }
      var qty = num(pick(it, ['availableQuantity', 'quantity', 'remainingQuantity']));
      if (qty === null) qty = mids.length || 1;
      var cat = pick(it, ['seatCatName', 'seatCategoryName', 'seatCategory', 'categoryName']);
      if (cat && typeof cat === 'object') cat = pick(cat, ['name', 'label']);
      // `price` is null on real listings; realPrice/priceWithCharge carry the amount.
      // Kept in NFF's own units (thousandths of a krone) so it round-trips into the
      // basket request unchanged; only the display divides by 1000.
      return {
        movementIds: mids,
        seatCategoryId: pick(it, ['seatCategoryId', 'seatCategory.id', 'seatCatId', 'categoryId']),
        audienceSubCategoryId: pick(it, ['audienceSubCategoryId', 'audienceSubCategory.id', 'audSubCatId', 'tariffId']),
        price: num(pick(it, ['realPrice', 'priceWithCharge', 'price', 'unitAmount', 'unitPrice', 'amount'])),
        category: str(cat),
        quantity: qty,
        place: AB.parsePlace(it),
        seats: Array.isArray(it.seats) ? it.seats : null,
        raw: it
      };
    });
  };

  // one entry per ticket; seatNo is null when the listing gives no seat number
  AB.expandSeats = function (items) {
    var seats = [];
    items.forEach(function (it, idx) {
      if (it.seats && it.seats.length) {
        it.seats.forEach(function (s, k) {
          var p = AB.parsePlace(s), mid = pick(s, ['movementId', 'id', 'ticketId']);
          if (mid === undefined) mid = it.movementIds[k];
          if (mid === undefined) return;
          seats.push({ movementId: mid, area: p.area !== null ? p.area : it.place.area,
                       row: p.row !== null ? p.row : it.place.row, seatNo: p.seatNo, item: it, key: idx + ':' + k });
        });
      } else if (!it.movementIds.length) {
        return;
      } else if (it.movementIds.length === 1 && it.quantity <= 1) {
        seats.push({ movementId: it.movementIds[0], area: it.place.area, row: it.place.row, seatNo: it.place.seatNo, item: it, key: String(idx) });
      } else {  // several tickets behind one line without per-seat numbers: cannot verify adjacency
        it.movementIds.forEach(function (mid, k) {
          seats.push({ movementId: mid, area: it.place.area, row: it.place.row, seatNo: null, item: it, key: idx + ':' + k });
        });
      }
    });
    return seats;
  };

  // ---- seat selection ------------------------------------------------------------
  // -> {count, seats:[...], pairs:[[a,b],...]} or null. 4 = two pairs (four in a row
  // preferred, else two pairs anywhere), else 2 = one pair. Never 1 or 3.
  AB.choosePairs = function (seats, want) {
    want = want || AB.WANT;
    var groups = {};
    seats.forEach(function (s) {
      if (s.movementId === undefined || s.seatNo === null || s.area === null || s.row === null) return;
      if (AB.EXCLUDE_AREA && AB.EXCLUDE_AREA.test(s.area)) return;
      var g = s.area + '' + s.row;
      (groups[g] = groups[g] || []).push(s);
    });
    var pairs = [];
    Object.keys(groups).forEach(function (g) {
      var arr = groups[g].sort(function (a, b) { return a.seatNo - b.seatNo; }), uniq = [];
      arr.forEach(function (s) { if (!uniq.length || uniq[uniq.length - 1].seatNo !== s.seatNo) uniq.push(s); });
      var run = [uniq[0]];
      for (var i = 1; i <= uniq.length; i++) {
        if (i < uniq.length && uniq[i].seatNo - uniq[i - 1].seatNo === AB.ADJACENT_STEP) { run.push(uniq[i]); continue; }
        for (var j = 0; j + 1 < run.length; j += 2) pairs.push({ seats: [run[j], run[j + 1]], runLength: run.length });
        if (i < uniq.length) run = [uniq[i]];
      }
    });
    if (!pairs.length) return null;
    pairs.sort(function (a, b) {
      return b.runLength - a.runLength || (a.seats[0].item.price || 0) - (b.seats[0].item.price || 0) || a.seats[0].seatNo - b.seats[0].seatNo;
    });
    for (var w = 0; w < want.length; w++) {
      var need = want[w] / 2;
      if (need !== Math.floor(need) || need < 1) continue;
      if (pairs.length >= need) {
        var chosen = pairs.slice(0, need), picked = [];
        chosen.forEach(function (p) { picked = picked.concat(p.seats); });
        return { count: want[w], seats: picked, pairs: chosen.map(function (p) { return p.seats; }) };
      }
    }
    return null;
  };

  // ---- basket request --------------------------------------------------------------
  // Same shape as the shop's own JavaScript builds for /ajax/selection/resale/item/submit
  AB.buildPayload = function (performanceId, seats) {
    var groups = {}, order = [];
    seats.forEach(function (s) {
      var it = s.item, key = [it.audienceSubCategoryId, it.seatCategoryId, it.price].join('|');
      if (!groups[key]) {
        groups[key] = { audienceSubCategoryId: it.audienceSubCategoryId, seatCategoryId: it.seatCategoryId,
                        quantity: 0, unitAmount: it.price, movementIds: [] };
        order.push(key);
      }
      groups[key].quantity += 1;
      groups[key].movementIds.push(s.movementId);
    });
    var pid = Number(performanceId);
    return { performanceId: isNaN(pid) ? performanceId : pid, resaleItemData: order.map(function (k) { return groups[k]; }) };
  };
  AB.payloadMissing = function (payload) {  // names of fields the listing did not provide
    var missing = {};
    (payload.resaleItemData || []).forEach(function (d) {
      ['audienceSubCategoryId', 'seatCategoryId', 'unitAmount'].forEach(function (f) {
        if (d[f] === undefined || d[f] === null) missing[f] = 1;
      });
      if (!d.movementIds || d.movementIds.length !== d.quantity || d.movementIds.some(function (m) { return m === undefined || m === null; })) missing.movementIds = 1;
    });
    if (!payload.resaleItemData || !payload.resaleItemData.length) missing.resaleItemData = 1;
    return Object.keys(missing);
  };

  // The real match page (15 Sep capture) is the seat-map variant: a plain form
  // <form id="ResaleItemFormModel" action="/selection/resale/item/submit" method="post">
  // with a Spring _csrf hidden input, into which its JS injects
  // resaleItemData[i].{audienceSubCategoryId,seatCategoryId,quantity,unitAmount,movementIds[j]}.
  // buildFormBody produces exactly that urlencoded body so the request is byte-for-byte
  // what clicking the page's own button sends.
  AB.buildFormBody = function (payload, csrf) {
    var parts = [['performanceId', payload.performanceId]];
    (payload.resaleItemData || []).forEach(function (d, i) {
      var p = 'resaleItemData[' + i + '].';
      parts.push([p + 'audienceSubCategoryId', d.audienceSubCategoryId]);
      parts.push([p + 'seatCategoryId', d.seatCategoryId]);
      parts.push([p + 'quantity', d.quantity]);
      parts.push([p + 'unitAmount', d.unitAmount]);
      (d.movementIds || []).forEach(function (mid, j) { parts.push([p + 'movementIds[' + j + ']', mid]); });
    });
    if (csrf) parts.push(['_csrf', csrf]);
    return parts.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1] === undefined || kv[1] === null ? '' : kv[1]); }).join('&');
  };

  AB.STATUS_TEXT = {
    OK: 'reserved',
    DENIED_BY_PKP: 'the waiting room denied the request',
    ERR_TOO_MANY_TICKETS: 'too many tickets for one order',
    ERR_ALREADY_FULL: 'the tickets were already taken',
    ERR_SALE_RESTRICTION: 'a sale restriction applies to this listing',
    ERR_NO_PERFORMANCE_AVAILABILITY: 'no availability for this match any more',
    ERR_NO_AVAILABLE_SEAT_CATEGORIES: 'no available seat categories',
    SHOP_ERROR: 'the shop returned its generic error page (busy or the ticket was taken)'
  };
  AB.describeStatus = function (status, params) {
    var t = AB.STATUS_TEXT[status] || ('the shop answered ' + status);
    if (status === 'ERR_TOO_MANY_TICKETS' && params && params.available) t += ' (max ' + params.available + ')';
    return t;
  };

  AB.kr = function (price) {   // NFF states amounts in thousandths of a krone (690000 = 690 kr)
    if (price === null || price === undefined) return null;
    return Math.round(price >= 100000 ? price / 1000 : price);
  };
  AB.describePairs = function (pairs) {
    return pairs.map(function (p) {
      var a = p[0], b = p[1], it = a.item, kr = AB.kr(it.price);
      return a.area + ' row ' + a.row + ' seats ' + a.seatNo + '-' + b.seatNo + (it.category ? ' ' + it.category : '') + (kr !== null ? ' ' + kr + ' kr' : '');
    }).join('; ');
  };
  AB.describeSeats = function (seats, max) {
    max = max || 6;
    var d = seats.map(function (s) {
      var kr = AB.kr(s.item.price);
      return (s.area || '?') + ' r' + (s.row || '?') + ' s' + (s.seatNo === null ? '?' : s.seatNo) + (kr !== null ? ' ' + kr : '');
    });
    return d.slice(0, max).join('; ') + (d.length > max ? ' +' + (d.length - max) + ' more' : '');
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = AB; return; }
  if (!root.document || !root.location || !/resale\.fotball\.no$/.test(root.location.hostname)) return;

  // ---- browser runtime -------------------------------------------------------------
  var win = root, doc = win.document;
  var store = {
    get: function (k, d) { try { var v = win.localStorage.getItem('autobasket.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { win.localStorage.setItem('autobasket.' + k, String(v)); } catch (e) { /* ignore */ } },
    del: function (k) { try { win.localStorage.removeItem('autobasket.' + k); } catch (e) { /* ignore */ } }
  };
  var state = {
    topic: store.get('topic', ''),
    armed: store.get('armed', '1') === '1',
    keepalive: store.get('keepalive', '1') === '1',
    sse: null, sseState: 'not connected', lastEvent: '-', lastAction: 'idle', keepaliveLast: '-',
    busy: false, leader: false, tabId: Math.random().toString(36).slice(2), audio: null, flashTimer: null
  };
  function hhmm(t) { var d = t ? new Date(t) : new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function log(s) { try { win.console.log('[auto-basket ' + hhmm() + '] ' + s); } catch (e) { /* ignore */ } }
  function setAction(s) { state.lastAction = hhmm() + ' ' + s; log(s); render(); }
  function seen(id) {  // persisted so a replayed alert after our own page navigation is not acted on twice
    if (!id) return false;
    var list = [];
    try { list = JSON.parse(store.get('seen', '[]')); } catch (e) { list = []; }
    if (list.indexOf(id) >= 0) return true;
    list.push(id); if (list.length > 100) list = list.slice(-100);
    store.set('seen', JSON.stringify(list));
    return false;
  }
  function untilMs(key) { var t = Number(store.get(key, '0')); return t > Date.now() ? t - Date.now() : 0; }
  function loggedIn() { return doc.querySelector('a[href*="logout"], form[action*="logout"]') ? 'yes' : 'not detected'; }

  // overlay
  var box = doc.createElement('div');
  box.id = 'autobasket-box';
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#eee;' +
    'font:12px/1.45 system-ui,Segoe UI,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.5);max-width:360px;';
  box.innerHTML = '<div id="ab-status" style="white-space:pre-wrap"></div>' +
    '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">' +
    '<button id="ab-audio">Arm audio / test alarm</button><button id="ab-toggle"></button>' +
    '<button id="ab-topic">Topic</button><button id="ab-keep"></button><button id="ab-reset">Reset</button></div>';
  doc.body.appendChild(box);
  function render() {
    var cd = untilMs('reservedAt') ? Math.ceil(untilMs('reservedAt') / 60000) + ' min cooldown after reservation' : '';
    var pause = untilMs('pausedUntil') ? Math.ceil(untilMs('pausedUntil') / 60000) + ' min pause after failure' : '';
    doc.getElementById('ab-status').textContent =
      'NFF auto-basket ' + AB.VERSION + (state.armed ? '  ARMED' : '  DRY RUN (no reservation)') + '\n' +
      'topic: ' + (state.topic ? state.topic.slice(0, 6) + '...' : 'NOT SET') + '   ntfy: ' + state.sseState + '\n' +
      'this tab: ' + (state.leader ? 'active' : 'standby (another tab is active)') + '   login: ' + loggedIn() + '\n' +
      'audio: ' + (state.audio ? 'armed' : 'NOT ARMED, click the button') + '   keepalive: ' + (state.keepalive ? state.keepaliveLast : 'off') + '\n' +
      'last alert: ' + state.lastEvent + '\n' + 'last action: ' + state.lastAction + (cd || pause ? '\n' + (cd || pause) : '');
    doc.getElementById('ab-toggle').textContent = state.armed ? 'Switch to dry run' : 'ARM';
    doc.getElementById('ab-keep').textContent = state.keepalive ? 'Keepalive off' : 'Keepalive on';
  }
  doc.getElementById('ab-audio').onclick = function () {
    ensureAudio(); alarm(2);
    try { if (win.Notification && win.Notification.permission === 'default') win.Notification.requestPermission(); } catch (e) { /* ignore */ }
    setAction('audio armed, test alarm played');
  };
  doc.getElementById('ab-toggle').onclick = function () { state.armed = !state.armed; store.set('armed', state.armed ? '1' : '0'); setAction(state.armed ? 'ARMED' : 'dry run'); };
  doc.getElementById('ab-keep').onclick = function () { state.keepalive = !state.keepalive; store.set('keepalive', state.keepalive ? '1' : '0'); render(); };
  doc.getElementById('ab-topic').onclick = function () {
    var t = win.prompt('ntfy topic (same as the watcher\'s NTFY_TOPIC secret):', state.topic);
    if (t !== null) { state.topic = t.trim(); store.set('topic', state.topic); connect(); }
  };
  doc.getElementById('ab-reset').onclick = function () { store.del('reservedAt'); store.del('pausedUntil'); store.del('seen'); state.busy = false; setAction('reset'); };

  // one active tab at a time (the others stand by)
  function heartbeat() {
    var now = Date.now(), cur = null;
    try { cur = JSON.parse(store.get('leader', 'null')); } catch (e) { cur = null; }
    if (!cur || cur.id === state.tabId || now - cur.t > 15000) { store.set('leader', JSON.stringify({ id: state.tabId, t: now })); state.leader = true; }
    else state.leader = false;
    render();
  }

  // alarm: a short, quiet beep sequence (ALARM_SECONDS at ALARM_GAIN), flashing tab title, desktop notification
  function ensureAudio() {
    if (state.audio) return state.audio;
    try { state.audio = new (win.AudioContext || win.webkitAudioContext)(); } catch (e) { log('no audio: ' + e); }
    return state.audio;
  }
  function alarm(seconds) {
    seconds = seconds || AB.ALARM_SECONDS;
    var ctx = ensureAudio();
    if (ctx) {
      try {
        if (ctx.state === 'suspended') ctx.resume();
        var t0 = ctx.currentTime;
        for (var i = 0; i < seconds * 2; i++) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = i % 2 ? 880 : 1320; g.gain.value = AB.ALARM_GAIN;
          o.connect(g); g.connect(ctx.destination); o.start(t0 + i * 0.5); o.stop(t0 + i * 0.5 + 0.3);
        }
      } catch (e) { log('audio failed: ' + e); }
    }
    var orig = doc.title, n = 0, flashes = AB.FLASH_SECONDS * 2;
    if (state.flashTimer) win.clearInterval(state.flashTimer);
    state.flashTimer = win.setInterval(function () { doc.title = (n++ % 2 ? '!!! TICKETS !!! ' : '>>> TICKETS <<< ') + orig; if (n > flashes) { win.clearInterval(state.flashTimer); doc.title = orig; } }, 500);
    try { if (win.Notification && win.Notification.permission === 'granted') new win.Notification('NFF auto-basket', { body: state.lastAction, requireInteraction: true }); } catch (e) { /* ignore */ }
  }

  // phone push via ntfy (same topic as the watcher; our own titles start with "Auto-basket")
  function push(priority, title, message, click) {
    if (!state.topic) return Promise.resolve();
    var headers = { 'Title': title, 'Priority': priority, 'Tags': 'shopping_cart,soccer' };
    if (click) headers['Click'] = /^https?:/.test(click) ? click : 'https://resale.fotball.no' + click;
    return win.fetch('https://ntfy.sh/' + encodeURIComponent(state.topic), { method: 'POST', headers: headers, body: message })
      .then(function () { log('pushed: ' + title); }, function (e) { log('push failed: ' + e); });
  }

  // shop requests from this session (same headers the site's own jQuery sends)
  function fetchJson(url) {
    return win.fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) {
        return r.text().then(function (t) {
          if (!r.ok) throw 'HTTP ' + r.status;
          try { return JSON.parse(t); } catch (e) { throw /Waiting Room/i.test(t) ? 'waiting room' : 'non-JSON answer'; }
        });
      });
  }
  // The match page carries the Spring _csrf token this session needs to POST. It is
  // fetched fresh (the script runs on the list page, which has no such token) and its
  // presence also proves the listing is still live and not behind the waiting room.
  function fetchItemPage(id) {
    return win.fetch(AB.matchPage(id), { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, url: r.url, html: t }; }); });
  }
  function csrfFrom(html) {
    var m = /name="_csrf"\s+value="([^"]+)"/.exec(html) || /name="_csrf"\s+content="([^"]+)"/.exec(html);
    return m ? m[1] : null;
  }
  function readAjaxAnswer(r, t) {
    var j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
    if (j && j.status) return j;
    if (/Waiting Room/i.test(t) || /pkpcontroller/.test(r.url)) return { status: 'DENIED_BY_PKP' };
    return null;   // not a recognised structured answer
  }
  // Reserve. Primary path mirrors the captured page exactly: urlencoded form POST to
  // /selection/resale/item/submit with the page's _csrf; success is a redirect into the
  // cart. If that endpoint is not the active one, the cached-mode ajax JSON endpoint is
  // tried. Either way a structured OK or a cart redirect => reserved.
  function submit(payload, csrf) {
    var body = AB.buildFormBody(payload, csrf);
    return win.fetch(AB.FORM_SUBMIT_PATH, {
      method: 'POST', credentials: 'same-origin', redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = readAjaxAnswer(r, t); if (j) return j;
        if (/pkpcontroller|Waiting Room/i.test(r.url + t)) return { status: 'DENIED_BY_PKP' };
        if (/\/(cart|shoppingCart)/i.test(r.url) && !/error/i.test(r.url)) return { status: 'OK', parameters: { redirect: AB.BASKET_PATH } };
        if (/(dessverre ikke behandle|Feil<|error-page|errorPage)/i.test(t)) return { status: 'SHOP_ERROR' };
        return tryAjax(payload, csrf);   // form endpoint inconclusive: try the ajax one
      });
    }, function () { return tryAjax(payload, csrf); });
  }
  function tryAjax(payload, csrf) {
    var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' };
    if (csrf) { headers['X-CSRF-TOKEN'] = csrf; headers['X-XSRF-TOKEN'] = csrf; }
    return win.fetch(AB.SUBMIT_PATH, { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify(payload) })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = readAjaxAnswer(r, t); if (j) return j;
          return { status: 'HTTP ' + r.status + ', unrecognised answer' };
        });
      }, function (e) { return { status: 'request failed: ' + e }; });
  }

  // one match: read listing -> choose -> reserve. Resolves {id, outcome, redirect?}
  function tryMatch(id) {
    var name = AB.MATCHES[id], page = AB.matchPage(id);
    function fail(text) { setAction(text); return push('urgent', AB.OWN_TITLE_PREFIX + ' FAILED', text + ' Match page opened on the laptop, do it by hand.', page).then(function () { return { id: id, outcome: 'failed' }; }); }
    return fetchJson(AB.ITEMS_PATH + '?performanceId=' + id + '&lang=en').then(function (raw) {
      var items = AB.normalizeItems(raw), seats = AB.expandSeats(items);
      var fields = items.length ? 'Fields: ' + Object.keys(items[0].raw).join(',') : '';
      if (!seats.length) {
        setAction(name + ': listing already gone');
        return push('default', AB.OWN_TITLE_PREFIX + ': ' + name + ' gone', name + ': the listing was already gone when the alert arrived.', page).then(function () { return { id: id, outcome: 'gone' }; });
      }
      var choice = AB.choosePairs(seats, AB.WANT);
      if (!choice) {
        var t1 = name + ': ' + seats.length + ' listed but no adjacent pair (' + AB.describeSeats(seats) + '). Not reserved. ' + fields;
        setAction(t1);
        return push('default', AB.OWN_TITLE_PREFIX + ': not reserved', t1, page).then(function () { return { id: id, outcome: 'no-pair' }; });
      }
      var payload = AB.buildPayload(id, choice.seats), missing = AB.payloadMissing(payload);
      var desc = choice.count + ' x ' + name + ' (' + AB.describePairs(choice.pairs) + ')';
      if (missing.length) return fail('Cannot build the basket request for ' + desc + ': the listing lacks ' + missing.join(', ') + '. ' + fields);
      if (!state.armed) {
        var t2 = 'DRY RUN: would reserve ' + desc + '.';
        setAction(t2);
        return push('urgent', AB.OWN_TITLE_PREFIX + ' dry run', t2 + ' Match page opened on the laptop.', page).then(function () { return { id: id, outcome: 'dryrun' }; });
      }
      setAction('reserving ' + desc);
      return fetchItemPage(id).then(function (pg) {   // fresh _csrf; also confirms the listing is still live
        var csrf = csrfFrom(pg.html);
        if (/pkpcontroller/.test(pg.url) || /Waiting Room/i.test(pg.html)) return { status: 'DENIED_BY_PKP' };
        return submit(payload, csrf).then(function (res) {
          if (res.status === 'ERR_TOO_MANY_TICKETS' && choice.count === 4) {   // shop caps the order: fall back to one pair
            var two = AB.choosePairs(seats, [2]);
            if (two) { desc = '2 x ' + name + ' (' + AB.describePairs(two.pairs) + ')'; setAction('retrying with ' + desc); return submit(AB.buildPayload(id, two.seats), csrf); }
          }
          return res;
        });
      }).then(function (res) {
        if (res.status === 'OK') {
          var t3 = 'RESERVED ' + desc + '. Pay NOW on the laptop, the basket hold is about 15 minutes.';
          setAction(t3);
          return push('urgent', AB.OWN_TITLE_PREFIX + ': RESERVED', t3, AB.BASKET_PATH).then(function () {
            return { id: id, outcome: 'reserved', redirect: res.parameters && res.parameters.redirect };
          });
        }
        return fail('Could not reserve ' + desc + ': ' + AB.describeStatus(res.status, res.parameters) + '.');
      });
    }, function (err) { return fail(name + ': could not read the listing (' + err + ').'); });
  }

  function handleResaleAlert(alert) {
    var ids = Object.keys(AB.MATCHES).filter(function (id) { var c = alert.counts[AB.MATCHES[id]]; return c === undefined || c > 0; });
    var results = [];
    return ids.reduce(function (p, id) { return p.then(function () { return tryMatch(id).then(function (r) { results.push(r); }); }); }, Promise.resolve())
      .then(function () {
        var ok = results.filter(function (r) { return r.outcome === 'reserved'; });
        var manual = results.filter(function (r) { return r.outcome === 'failed' || r.outcome === 'dryrun'; });
        if (ok.length) {
          store.set('reservedAt', String(Date.now() + AB.COOLDOWN_MS));
          alarm();
          win.setTimeout(function () { win.location.href = ok[ok.length - 1].redirect || AB.BASKET_PATH; }, 300);
        } else if (manual.length) {
          store.set('pausedUntil', String(Date.now() + AB.PAUSE_MS));
          alarm();
          win.setTimeout(function () { win.location.href = AB.matchPage(manual[0].id); }, 300);
        }
      });
  }

  function onNtfy(m) {
    if (!m || m.event !== 'message') return;
    if (seen(m.id)) return;
    state.lastEvent = hhmm(m.time ? m.time * 1000 : undefined) + ' ' + (m.title || '(no title)'); render();
    var alert = AB.parseAlert(m);
    if (!alert) return;
    if (m.time && Date.now() - m.time * 1000 > AB.STALE_MS) { log('stale alert ignored'); return; }
    if (!state.leader) { log('standby tab, ignoring'); return; }
    if (alert.kind === 'shop') { setAction('main shop shows tickets on sale: ' + AB.SHOP_PAGE); alarm(); return; }
    if (untilMs('reservedAt')) { setAction('alert ignored: reservation cooldown'); return; }
    if (untilMs('pausedUntil')) { setAction('alert ignored: paused after a failure (you are on it by hand)'); return; }
    if (state.busy) return;
    state.busy = true;
    handleResaleAlert(alert).catch(function (e) { setAction('error: ' + e); alarm(); }).then(function () { state.busy = false; render(); });
  }

  function connect() {
    if (state.sse) { try { state.sse.close(); } catch (e) { /* ignore */ } state.sse = null; }
    if (!state.topic) { state.sseState = 'no topic set'; render(); return; }
    var es;
    try { es = new win.EventSource('https://ntfy.sh/' + encodeURIComponent(state.topic) + '/sse?since=90s'); }
    catch (e) { state.sseState = 'cannot connect: ' + e; render(); return; }
    state.sse = es; state.sseState = 'connecting'; render();
    es.addEventListener('open', function () { state.sseState = 'connected ' + hhmm(); render(); });
    es.addEventListener('keepalive', function () { state.sseState = 'connected, keepalive ' + hhmm(); render(); });
    es.addEventListener('error', function () {
      state.sseState = (es.readyState === 2 ? 'closed, retrying' : 'reconnecting') + ' ' + hhmm(); render();
      if (es.readyState === 2) win.setTimeout(function () { if (state.sse === es) connect(); }, 5000);
    });
    es.addEventListener('message', function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onNtfy(m); });
  }

  function keepalive() {
    if (!state.keepalive) return;
    win.fetch(AB.KEEPALIVE_PATH, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { state.keepaliveLast = hhmm() + ' HTTP ' + r.status; render(); }, function (e) { state.keepaliveLast = hhmm() + ' failed ' + e; render(); });
  }

  heartbeat(); win.setInterval(heartbeat, 5000);
  win.setInterval(keepalive, AB.KEEPALIVE_MS);
  win.setInterval(render, 30000);
  connect();
  if (!state.topic) win.setTimeout(function () { doc.getElementById('ab-topic').onclick(); }, 500);
  render();
})(typeof window !== 'undefined' ? window : globalThis);

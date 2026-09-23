// ==UserScript==
// @name         NFF resale auto-basket
// @namespace    https://github.com/Mikkelnaes/nff-resale-watch
// @version      0.3.1
// @description  Watches NFF resale from your own logged-in browser, and when 2 or 4 adjacent Norway-Denmark / Norway-Portugal seats appear it rides the real waiting room and reserves them in your basket.
// @match        https://resale.fotball.no/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  Strategy (design: docs/superpowers/specs/2026-09-15-auto-basket-design.md, revised 16 Sep)

  The reservation is gated by SecuTix's virtual waiting room + a bot wall. A background
  request is bounced (proven 16 Sep: "waiting room denied"). Only a real page navigation
  passes the queue. So this script does what a human does, but instantly:

  1. DETECT fast. On the resale list page it reads the Denmark and Portugal listings every
     POLL_MS (3 s) from your admitted session, far faster than the 30 s cloud watcher. The
     ntfy alert is a secondary nudge to poll immediately.
  2. GRAB via a real navigation. When 2 or 4 adjacent seats are found it stores the intent
     and navigates the tab to the match page, entering the queue for real. When the page
     comes through, it fills the page's own form and submits it (a real navigation the
     queue trusts), landing in the cart.
  3. PERSIST. A miss (queue, gone, refused) sends it back to the list to keep watching and
     catch the ~15 min hold-expiry re-release, up to MAX_TRIES within WINDOW_MS.

  It never pays: on success it alarms, pushes "RESERVED, pay now" and opens the cart, and
  you pay by hand within ~15 min. Adjacent = same section, same row, seat numbers one
  apart; 4 preferred, else 2, never 1 or 3. Nothing bypasses a captcha.

  The pure decision logic is exported for `node test_autobasket.js`.
*/
(function (root) {
  'use strict';

  var AB = {
    VERSION: '0.3.1',
    MATCHES: { '10229739913106': 'Denmark', '10229739913107': 'Portugal' },
    WANT: [4, 2],                 // 4 first (two adjacent pairs), else 2 (one pair); never 1 or 3
    ADJACENT_STEP: 1,             // seat numbers this far apart count as neighbours (set 2 if Ullevaal numbers odd/even from the aisle)
    EXCLUDE_AREA: null,           // e.g. /^(10[7-9]|11[0-2]|40[7-9]|41[0-4])$/ to skip the away blocks; null = any section
    POLL_MS: 3000,                // in-browser listing poll interval
    COOLDOWN_MS: 20 * 60 * 1000,  // after a reservation: ignore everything this long (basket hold ~15 min)
    TEST_COOLDOWN_MS: 90 * 1000,  // after the one-off smoke test: short, so a real pair is not missed
    WINDOW_MS: 15 * 60 * 1000,    // keep chasing the same seats at most this long
    MAX_TRIES: 25,                // ...and at most this many navigations
    BACKOFF_MS: 4000,             // wait this long between attempts on the same seats
    REAPPEAR_MS: 45 * 1000,       // the same seats unseen this long, then back = a re-release: fresh window and tries
    INTENT_TTL_MS: 3 * 60 * 1000, // a stored grab intent older than this is stale
    STALE_MS: 2 * 60 * 1000,      // ntfy alerts older than this are ignored
    KEEPALIVE_MS: 10 * 60 * 1000, // light request so the login does not time out
    ALARM_SECONDS: 2,             // short beep sequence
    ALARM_GAIN: 0.08,             // quiet (0..1)
    FLASH_SECONDS: 10,            // tab title flashes this long
    ALERT_TITLE_RESALE: 'TICKETS LISTED on NFF resale!',
    ALERT_TITLE_SHOP: 'TICKETS ON SALE at billett.fotball.no!',
    OWN_TITLE_PREFIX: 'Auto-basket',
    FORM_ID: 'ResaleItemFormModel',
    FORM_SUBMIT_PATH: '/selection/resale/item/submit',
    ITEMS_PATH: '/selection/resale/resaleItems.json',
    LIST_PATH: '/list/resaleProducts/?lang=en',
    BASKET_PATH: '/cart/shoppingCart?lang=en',
    KEEPALIVE_PATH: '/cartData.json?lang=en',
    SHOP_PAGE: 'https://billett.fotball.no/selection/event/date?productId=10229739619905&lang=en'
  };
  AB.matchPage = function (id) {
    return '/selection/resale/item?performanceId=' + id + '&checkResaleAvailability=true&lang=en';
  };

  // ---- helpers -------------------------------------------------------------------
  function pick(obj, paths) {
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

  // ---- alert parsing (secondary trigger) -----------------------------------------
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

  // ---- item normalisation (real 15 Sep fields: block, remark "row - seat", realPrice) --
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
      // The buyer purchases at the tariff offered in pricesSelection ("Resale"), not the
      // ticket's original tariff (audienceSubCategoryId = "Adult"). The page's own form
      // sends the selected pricesSelection entry, so that is what the request must carry.
      var ps = Array.isArray(it.pricesSelection) && it.pricesSelection.length ? it.pricesSelection[0] : null;
      var tariff = ps ? pick(ps, ['audienceSubCatId', 'audienceSubCategoryId']) : undefined;
      var amount = ps ? num(pick(ps, ['amount', 'unitAmount', 'price'])) : null;
      // The seated resale form (stx2js addToCart for resaleItems.json) posts, per row:
      // audienceSubCategoryId, seatCategoryId, quantity, unitAmount, key, priceLevelId, movementIds.
      // priceLevelId comes from the selected price (often null) and MUST be sent even when null,
      // or a 2-seat submit is rejected back to the item page (proven 18 Sep on the 421 pair).
      var plId = ps && ('priceLevelId' in ps) ? ps.priceLevelId : pick(it, ['priceLevelId']);
      return {
        key: pick(it, ['key']),   // the row identity the form posts as resaleItemData[i].key
        movementIds: mids,
        seatCategoryId: pick(it, ['seatCategoryId', 'seatCategory.id', 'seatCatId', 'categoryId']),
        priceLevelId: plId === undefined ? null : plId,
        audienceSubCategoryId: tariff !== undefined ? tariff : pick(it, ['audienceSubCategoryId', 'audienceSubCategory.id', 'audSubCatId', 'tariffId']),
        price: amount !== null ? amount : num(pick(it, ['realPrice', 'priceWithCharge', 'price', 'unitAmount', 'unitPrice', 'amount'])),
        category: str(cat),
        quantity: qty,
        place: AB.parsePlace(it),
        seats: Array.isArray(it.seats) ? it.seats : null,
        raw: it
      };
    });
  };

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
      } else {
        it.movementIds.forEach(function (mid, k) {
          seats.push({ movementId: mid, area: it.place.area, row: it.place.row, seatNo: null, item: it, key: idx + ':' + k });
        });
      }
    });
    return seats;
  };

  // ---- seat selection ------------------------------------------------------------
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
  AB.seatKey = function (choice) {
    if (!choice || !choice.seats) return '';
    return choice.seats.map(function (s) { return String(s.movementId); }).sort().join(',');
  };
  // Smoke-test chooser: any n tickets with a movement id, no adjacency rule (used once, to
  // prove the submit path on a single ticket that nobody wants; the user then empties the cart).
  AB.chooseAny = function (seats, n) {
    var ok = seats.filter(function (s) { return s.movementId !== undefined && s.movementId !== null; });
    if (!ok.length) return null;
    ok.sort(function (a, b) { return (b.seatNo !== null) - (a.seatNo !== null); });   // numbered seats first
    var picked = ok.slice(0, n || 1);
    return { count: picked.length, seats: picked, pairs: [] };
  };

  // ---- basket request --------------------------------------------------------------
  // One resaleItemData entry PER SEAT, exactly as the seated page's own form posts it.
  // The resaleItems.json module (stx2js 1642) keeps every JSON row as its own model
  // (enhencingItems without isTicketsGrouped) and addToCart emits one entry per row with
  // orderQuantity 1, so a pair is TWO entries of quantity 1 sharing the same key. Sending
  // one entry with quantity 2 was rejected back to the item page (18 and 21 Sep).
  AB.buildPayload = function (performanceId, seats) {
    var rows = seats.map(function (s) {
      var it = s.item;
      return { key: it.key !== undefined ? it.key : null, audienceSubCategoryId: it.audienceSubCategoryId,
               seatCategoryId: it.seatCategoryId, priceLevelId: it.priceLevelId !== undefined ? it.priceLevelId : null,
               quantity: 1, unitAmount: it.price, movementIds: [s.movementId] };
    });
    var pid = Number(performanceId);
    return { performanceId: isNaN(pid) ? performanceId : pid, resaleItemData: rows };
  };
  // The page can only add ONE seat per submit: its model lookup v(key) returns the first row
  // with that key, so both seats of a pair (same key) can never be selected together, and a
  // 2-seat submit is rejected (validation re-render for quantity 2, error page for two rows).
  // A single-seat submit is the proven path (17 Sep). So a pair is bought as a SEQUENCE of
  // single submits: seat A -> cart -> back to the match page -> seat B -> cart.
  AB.singlePayloads = function (performanceId, seats) {
    return seats.map(function (s) { return AB.buildPayload(performanceId, [s]); });
  };
  AB.payloadMissing = function (payload) {
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
  // Fills the match page's own <form id="ResaleItemFormModel"> so submitting it is
  // byte-for-byte what clicking the page's button sends. Also used for the fallback POST.
  AB.buildFormBody = function (payload, csrf) {
    var parts = [['performanceId', payload.performanceId]];
    (payload.resaleItemData || []).forEach(function (d, i) {   // same fields and order as the page's own addToCart
      var p = 'resaleItemData[' + i + '].';
      parts.push([p + 'audienceSubCategoryId', d.audienceSubCategoryId]);
      parts.push([p + 'seatCategoryId', d.seatCategoryId]);
      parts.push([p + 'quantity', d.quantity]);
      parts.push([p + 'unitAmount', d.unitAmount]);
      if (d.key !== undefined && d.key !== null) parts.push([p + 'key', d.key]);
      // Only when the listing gives a real priceLevelId. The one submit proven to work
      // (17 Sep single) carried no priceLevelId field; an empty one is an untested difference.
      if (d.priceLevelId !== undefined && d.priceLevelId !== null && d.priceLevelId !== '') parts.push([p + 'priceLevelId', d.priceLevelId]);
      (d.movementIds || []).forEach(function (mid, j) { parts.push([p + 'movementIds[' + j + ']', mid]); });
    });
    if (csrf) parts.push(['_csrf', csrf]);
    return parts.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1] === undefined || kv[1] === null ? '' : kv[1]); }).join('&');
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

  // ---- page + intent (state machine across the queue navigation) -----------------
  AB.pageMode = function (pathname, title) {
    pathname = pathname || ''; title = title || '';
    if (/Waiting Room|Cookies appear to be disabled/i.test(title) || /cookieWarning|pkpcontroller/i.test(pathname)) return 'queue';
    if (/\/cart(\/|\b)|\/checkout(\/|\b)/i.test(pathname)) return 'cart';   // checkout steps mean the basket holds the seats
    if (/\/selection\/resale\/item(\?|\b)/i.test(pathname)) return 'item';
    if (/\/list\/resale/i.test(pathname)) return 'list';
    return 'other';
  };
  AB.intentFresh = function (intent, now, ttl) {
    return !!(intent && intent.pid && typeof intent.createdAt === 'number' && (now - intent.createdAt) <= ttl);
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = AB; return; }
  if (!root.document || !root.location || !/resale\.fotball\.no$/.test(root.location.hostname)) return;

  // ================================ browser runtime ================================
  var win = root, doc = win.document;
  var store = {
    get: function (k, d) { try { var v = win.localStorage.getItem('autobasket.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { win.localStorage.setItem('autobasket.' + k, String(v)); } catch (e) { /* ignore */ } },
    del: function (k) { try { win.localStorage.removeItem('autobasket.' + k); } catch (e) { /* ignore */ } }
  };
  function getJSON(k) { try { return JSON.parse(store.get(k, 'null')); } catch (e) { return null; } }
  function setJSON(k, v) { if (v) store.set(k, JSON.stringify(v)); else store.del(k); }

  var state = {
    topic: store.get('topic', ''),
    armed: store.get('armed', '1') === '1',
    keepalive: store.get('keepalive', '1') === '1',
    testOnce: store.get('testOnce', '0') === '1',   // one-off: reserve the next single ticket to prove the submit path
    mode: '-', sse: null, sseState: 'not connected', pollLast: '-', lastEvent: '-', lastAction: 'idle',
    busy: false, leader: false, lastDry: '', tabId: Math.random().toString(36).slice(2), audio: null, flashTimer: null
  };
  function hhmm(t) { var d = t ? new Date(t) : new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function log(s) { try { win.console.log('[auto-basket ' + hhmm() + '] ' + s); } catch (e) { /* ignore */ } }
  function setAction(s) { state.lastAction = hhmm() + ' ' + s; log(s); render(); }
  function untilMs(key) { var t = Number(store.get(key, '0')); return t > Date.now() ? t - Date.now() : 0; }
  function pageMode() { return AB.pageMode(win.location.pathname, doc.title); }
  function loggedIn() { return doc.querySelector('a[href*="logout"], form[action*="logout"]') ? 'yes' : 'not detected'; }
  function seen(id) {
    if (!id) return false;
    var list = getJSON('seen') || [];
    if (list.indexOf(id) >= 0) return true;
    list.push(id); if (list.length > 100) list = list.slice(-100);
    setJSON('seen', list);
    return false;
  }

  // ---- overlay -------------------------------------------------------------------
  var box = doc.createElement('div');
  box.id = 'autobasket-box';
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#eee;' +
    'font:12px/1.45 system-ui,Segoe UI,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.5);max-width:380px;';
  box.innerHTML = '<div id="ab-status" style="white-space:pre-wrap"></div>' +
    '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">' +
    '<button id="ab-audio">Arm audio / test alarm</button><button id="ab-toggle"></button>' +
    '<button id="ab-topic">Topic</button><button id="ab-keep"></button><button id="ab-test"></button><button id="ab-reset">Reset</button></div>';
  function mountOverlay() { if (doc.body && !doc.getElementById('autobasket-box')) { doc.body.appendChild(box); wireButtons(); } }
  function render() {
    var el = doc.getElementById('ab-status'); if (!el) return;
    var grab = getJSON('grab');
    var cd = untilMs('reservedAt') ? Math.ceil(untilMs('reservedAt') / 60000) + ' min cooldown after reservation' : '';
    el.textContent =
      'NFF auto-basket ' + AB.VERSION + (state.armed ? '  ARMED' : '  DRY RUN (no reservation)') + '\n' +
      'page: ' + state.mode + '   topic: ' + (state.topic ? state.topic.slice(0, 6) + '...' : 'NOT SET') + '   ntfy: ' + state.sseState + '\n' +
      'this tab: ' + (state.leader ? 'active' : 'standby') + '   login: ' + loggedIn() + '   audio: ' + (state.audio ? 'armed' : 'NOT ARMED') + '\n' +
      'poll: ' + state.pollLast + '   last alert: ' + state.lastEvent + '\n' +
      'last action: ' + state.lastAction + (grab ? '\ntarget: ' + grab.key + ' (try ' + grab.tries + '/' + AB.MAX_TRIES + ')' : '') + (cd ? '\n' + cd : '') +
      (state.testOnce ? '\nTEST MODE: next single ticket is reserved once to prove the path (a real pair still wins)' : '');
    var tg = doc.getElementById('ab-toggle'); if (tg) tg.textContent = state.armed ? 'Switch to dry run' : 'ARM';
    var kp = doc.getElementById('ab-keep'); if (kp) kp.textContent = state.keepalive ? 'Keepalive off' : 'Keepalive on';
    var tb = doc.getElementById('ab-test'); if (tb) tb.textContent = state.testOnce ? 'Cancel test' : 'Test on next single';
  }
  function wireButtons() {
    doc.getElementById('ab-audio').onclick = function () {
      ensureAudio(); alarm(AB.ALARM_SECONDS);
      try { if (win.Notification && win.Notification.permission === 'default') win.Notification.requestPermission(); } catch (e) { /* ignore */ }
      setAction('audio armed, test alarm played');
    };
    doc.getElementById('ab-toggle').onclick = function () { state.armed = !state.armed; store.set('armed', state.armed ? '1' : '0'); state.lastDry = ''; setAction(state.armed ? 'ARMED' : 'dry run'); };
    doc.getElementById('ab-keep').onclick = function () { state.keepalive = !state.keepalive; store.set('keepalive', state.keepalive ? '1' : '0'); render(); };
    doc.getElementById('ab-topic').onclick = function () {
      var t = win.prompt('ntfy topic (same as the watcher\'s NTFY_TOPIC secret):', state.topic);
      if (t !== null) { state.topic = t.trim(); store.set('topic', state.topic); connectNtfy(); }
    };
    doc.getElementById('ab-test').onclick = function () {
      state.testOnce = !state.testOnce; store.set('testOnce', state.testOnce ? '1' : '0');
      setAction(state.testOnce ? 'TEST MODE armed: the next single ticket will be reserved once (empty the cart afterwards)' : 'test mode off');
    };
    doc.getElementById('ab-reset').onclick = function () {
      ['reservedAt', 'grab', 'intent', 'testOnce'].forEach(store.del); state.busy = false; state.lastDry = ''; state.testOnce = false; setAction('reset');
    };
  }

  // ---- one active tab ------------------------------------------------------------
  function heartbeat() {
    var now = Date.now(), cur = getJSON('leader');
    if (!cur || cur.id === state.tabId || now - cur.t > 15000) { setJSON('leader', { id: state.tabId, t: now }); state.leader = true; }
    else state.leader = false;
    render();
  }

  // ---- alarm ---------------------------------------------------------------------
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

  // ---- ntfy (phone push out + secondary trigger in) ------------------------------
  function push(priority, title, message, click) {
    if (!state.topic) return Promise.resolve();
    var headers = { 'Title': title, 'Priority': priority, 'Tags': 'shopping_cart,soccer' };
    if (click) headers['Click'] = /^https?:/.test(click) ? click : 'https://resale.fotball.no' + click;
    return win.fetch('https://ntfy.sh/' + encodeURIComponent(state.topic), { method: 'POST', headers: headers, body: message })
      .then(function () { log('pushed: ' + title); }, function (e) { log('push failed: ' + e); });
  }
  function connectNtfy() {
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
      if (es.readyState === 2) win.setTimeout(function () { if (state.sse === es) connectNtfy(); }, 5000);
    });
    es.addEventListener('message', function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onNtfy(m); });
  }
  function onNtfy(m) {
    if (!m || m.event !== 'message') return;
    if (seen(m.id)) return;
    state.lastEvent = hhmm(m.time ? m.time * 1000 : undefined) + ' ' + (m.title || '(no title)'); render();
    var a = AB.parseAlert(m); if (!a) return;
    if (m.time && Date.now() - m.time * 1000 > AB.STALE_MS) return;
    if (a.kind === 'shop') { alarm(); setAction('main shop shows tickets on sale: ' + AB.SHOP_PAGE); return; }
    if (state.leader && pageMode() === 'list') pollOnce();   // nudge an immediate poll
  }

  // ---- shop reads ----------------------------------------------------------------
  function fetchItems(id) {
    return win.fetch(AB.ITEMS_PATH + '?performanceId=' + id + '&lang=en', { credentials: 'same-origin', headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) {
        return r.text().then(function (t) {
          // NFF made this endpoint login-only on 17 Sep 2026; the logged-in tab still gets
          // JSON, but if the session drops we get the login page instead of silent nonsense.
          if (/\/account\/(login|identification)/i.test(r.url) || /action="\/account\/login"|<title>Identification/i.test(t)) throw 'login';
          if (!r.ok) throw 'HTTP ' + r.status;
          try { return JSON.parse(t); } catch (e) { throw /Waiting Room/i.test(t) ? 'waiting room' : 'non-JSON'; }
        });
      });
  }
  function csrfFrom(html) {
    var m = /name="_csrf"\s+value="([^"]+)"/.exec(html) || /name="_csrf"\s+content="([^"]+)"/.exec(html);
    return m ? m[1] : null;
  }

  // ---- decide -------------------------------------------------------------------
  // -> a target {id,name,choice,payload,key,desc} when a complete, sendable pair exists, else null
  // testMode: if no real pair exists but at least one ticket does, return a 1-ticket
  // smoke-test target (test:true). A real pair always takes precedence over the test.
  function targetFor(id, raw, testMode) {
    var name = AB.MATCHES[id];
    var seats = AB.expandSeats(AB.normalizeItems(raw));
    var choice = AB.choosePairs(seats, AB.WANT), test = false;
    if (!choice && testMode && seats.length) { choice = AB.chooseAny(seats, 1); test = true; }
    if (!choice) return null;
    var payload = AB.buildPayload(id, choice.seats);
    var desc = test
      ? 'TEST 1 x ' + name + ' (' + AB.describeSeats(choice.seats) + ')'
      : choice.count + ' x ' + name + ' (' + AB.describePairs(choice.pairs) + ')';
    if (AB.payloadMissing(payload).length) {
      push('urgent', AB.OWN_TITLE_PREFIX + ': check ' + name, name + ' found (' + desc + ') but the listing lacked the ids to reserve. Open the match page.', AB.matchPage(id));
      return null;
    }
    return { id: id, name: name, choice: choice, payload: payload, key: AB.seatKey(choice), desc: desc, test: test };
  }

  // ---- list page: poll + grab ----------------------------------------------------
  function pollOnce() {
    if (!state.leader || state.busy) { return; }
    if (pageMode() !== 'list') return;
    if (untilMs('reservedAt')) { state.pollLast = hhmm() + ' cooldown'; render(); return; }
    var ids = Object.keys(AB.MATCHES), found = null, chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        if (found) return;
        return fetchItems(id).then(function (raw) {
          state.pollLast = hhmm() + ' ok'; state.loginWarned = false;
          var t = targetFor(id, raw, state.testOnce); if (t && !found) found = t;
        }, function (err) {
          state.pollLast = hhmm() + ' ' + err;
          if (err === 'login' && !state.loginWarned) {   // session dropped: tell the phone once
            state.loginWarned = true;
            setAction('SESSION EXPIRED - log in again on resale.fotball.no');
            alarm();
            push('urgent', AB.OWN_TITLE_PREFIX + ': LOG IN', 'Your resale.fotball.no session dropped, so the auto-basket is blind. Open the tab and log in again.', AB.LIST_PATH);
          }
        });
      });
    });
    return chain.then(function () { render(); if (found) act(found); });
  }
  // The grab record caps attempts on one seat-set. Two lessons from 21 Sep: (1) the same
  // seats bounce back every ~15 min when a hold expires, and a window anchored to the
  // FIRST sighting had expired by then, so the re-release was refused with a stale try
  // count from the old payload; now a seat-set unseen for REAPPEAR_MS and back again gets
  // a fresh window and fresh tries. (2) giving up used to be silent; now it alarms and
  // pushes "buy by hand" once, because the seats are still listed at that moment.
  function canTry(target) {
    var now = Date.now(), grab = getJSON('grab');
    var fresh = !grab || grab.key !== target.key || (grab.lastSeen && now - grab.lastSeen > AB.REAPPEAR_MS);
    if (fresh) grab = { key: target.key, tries: 0, since: now, nextTryAt: 0, gaveUp: false };
    grab.lastSeen = now; setJSON('grab', grab);
    if (grab.tries >= AB.MAX_TRIES || (now - grab.since) > AB.WINDOW_MS) {
      if (!grab.gaveUp) {
        grab.gaveUp = true; setJSON('grab', grab);
        setAction('GAVE UP ' + target.name + ' after ' + grab.tries + ' tries - BUY BY HAND NOW');
        alarm();
        push('urgent', AB.OWN_TITLE_PREFIX + ' GAVE UP', target.desc + ': ' + grab.tries + ' tries failed this window and the seats are STILL LISTED. Buy by hand now.', AB.matchPage(target.id));
      }
      return false;
    }
    if (grab.nextTryAt && now < grab.nextTryAt) return false;
    return true;
  }
  function act(target) {
    if (untilMs('reservedAt')) return;
    if (!state.armed && !target.test) {   // the smoke test is a real reservation even in dry run
      if (state.lastDry === target.key) return;
      state.lastDry = target.key;
      setAction('DRY RUN would reserve ' + target.desc);
      alarm();
      push('urgent', AB.OWN_TITLE_PREFIX + ' dry run', 'Would reserve ' + target.desc + '. (dry run, nothing reserved)', AB.matchPage(target.id));
      return;
    }
    if (!canTry(target)) return;
    state.busy = true;
    // The seats travel with the intent as a QUEUE of single-seat payloads: the match page
    // submits one, lands in the cart, comes back for the next, until the queue is empty.
    var queue = AB.singlePayloads(target.id, target.choice.seats);
    setJSON('intent', { pid: target.id, name: target.name, key: target.key, desc: target.desc, queue: queue, got: [], total: queue.length,
                        test: !!target.test, createdAt: Date.now(), status: 'go' });
    setAction((target.test ? 'TEST: ' : '') + 'grabbing ' + target.desc + ' -> entering the queue');
    win.setTimeout(function () { win.location.href = AB.matchPage(target.id); }, 50);
  }

  // ---- item page: complete the reservation on the real page ----------------------
  function fulfillItemPage() {
    var intent = getJSON('intent'), now = Date.now();
    if (!AB.intentFresh(intent, now, AB.INTENT_TTL_MS)) { store.del('intent'); return; }
    var pid = String(intent.pid);
    if (win.location.search.indexOf('performanceId=' + pid) < 0) return;   // a match we are not chasing
    if (intent.status === 'submitting') { checkPostSubmit(); return; }
    var csrf = csrfFrom(doc.documentElement.innerHTML);
    // One seat per submit (see AB.singlePayloads). Take the next single-seat payload from
    // the queue and submit it at once; the cart landing (checkPostSubmit) comes back for the rest.
    var queue = intent.queue || (intent.payload ? [intent.payload] : []);
    intent.got = intent.got || []; intent.total = intent.total || (queue.length + intent.got.length);
    if (!queue.length) { store.del('intent'); return; }
    intent.queue = queue; intent.current = queue[0];
    setAction('through the queue on ' + intent.name + ', adding seat ' + (intent.got.length + 1) + '/' + intent.total);
    submitRealForm(queue[0], csrf, intent, intent.desc);
  }
  function submitRealForm(payload, csrf, intent, desc) {
    intent.status = 'submitting'; intent.desc = desc; setJSON('intent', intent);
    if (intent.test) { store.del('testOnce'); state.testOnce = false; }   // one shot: consumed the moment we actually send
    var form = doc.getElementById(AB.FORM_ID);
    if (!form) { return submitBg(payload, csrf, intent, desc); }
    Array.prototype.slice.call(form.querySelectorAll('input[name^="resaleItemData"], input[name="performanceId"]'))
      .forEach(function (n) { n.parentNode.removeChild(n); });
    function add(name, val) { var i = doc.createElement('input'); i.type = 'hidden'; i.name = name; i.value = (val === undefined || val === null ? '' : val); form.appendChild(i); }
    add('performanceId', payload.performanceId);
    payload.resaleItemData.forEach(function (d, idx) {
      var p = 'resaleItemData[' + idx + '].';
      add(p + 'audienceSubCategoryId', d.audienceSubCategoryId);
      add(p + 'seatCategoryId', d.seatCategoryId);
      add(p + 'quantity', d.quantity);
      add(p + 'unitAmount', d.unitAmount);
      if (d.key !== undefined && d.key !== null) add(p + 'key', d.key);
      if (d.priceLevelId !== undefined && d.priceLevelId !== null && d.priceLevelId !== '') add(p + 'priceLevelId', d.priceLevelId);
      (d.movementIds || []).forEach(function (mid, j) { add(p + 'movementIds[' + j + ']', mid); });
    });
    if (csrf && !form.querySelector('input[name="_csrf"]')) add('_csrf', csrf);
    setAction('submitting ' + desc);
    form.submit();   // real navigation: lands on the cart, or an error page
  }
  function submitBg(payload, csrf, intent, desc) {   // fallback if the page has no form
    win.fetch(AB.FORM_SUBMIT_PATH, { method: 'POST', credentials: 'same-origin', redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: AB.buildFormBody(payload, csrf) })
      .then(function (r) {
        return r.text().then(function (t) {
          if (/\/(cart|shoppingCart)/i.test(r.url) && !/error/i.test(r.url)) return advance(intent);
          var j = null; try { j = JSON.parse(t); } catch (e) { /* ignore */ }
          if (j && j.status === 'OK') return advance(intent);
          failGrab(intent, 'shop refused (' + ((j && j.status) || 'queue/again') + ')');
        });
      }, function (e) { failGrab(intent, 'request failed: ' + e); });
  }

  // ---- outcomes ------------------------------------------------------------------
  function checkPostSubmit() {   // ran on the page we land on after form.submit()
    var intent = getJSON('intent');
    if (!intent || intent.status !== 'submitting') return false;
    var mode = pageMode();
    if (mode === 'cart') { advance(intent); return true; }
    if (mode === 'queue') { setAction('in the waiting room, holding for ' + intent.name); return true; }
    // Not the cart: report exactly where we landed so the next miss is diagnosable
    var where = win.location.pathname + win.location.search;
    var errText = (doc.body && doc.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
    var reason = 'submit landed on ' + where + ' ["' + doc.title + '"]: ' + errText;
    if (intent.got && intent.got.length) partialFail(intent, reason); else failGrab(intent, reason);
    return true;
  }
  // One seat just landed in the cart. More in the queue -> straight back to the match page
  // for the next one; queue empty -> the whole set is reserved.
  function advance(intent) {
    intent.got = intent.got || []; intent.queue = intent.queue || [];
    if (intent.current) intent.got.push(intent.current);
    intent.queue.shift(); intent.current = null;
    if (intent.queue.length) {
      intent.status = 'go'; setJSON('intent', intent);
      setAction('seat ' + intent.got.length + '/' + intent.total + ' in the cart, fetching the next');
      win.setTimeout(function () { win.location.href = AB.matchPage(intent.pid); }, 150);
      return;
    }
    succeed(intent.desc, AB.BASKET_PATH, !!intent.test);
  }
  // Some seats are in the cart but the next one was refused or gone: stop, tell the user
  // exactly what they hold, and let them decide to pay for those or empty the cart.
  function partialFail(intent, reason) {
    store.del('grab'); store.del('intent'); state.busy = false;
    store.set('reservedAt', String(Date.now() + AB.COOLDOWN_MS));
    var n = (intent.got || []).length, tot = intent.total || (n + (intent.queue || []).length);
    setAction('PARTIAL: ' + n + ' of ' + tot + ' seats in the cart; the rest failed');
    alarm();
    push('urgent', AB.OWN_TITLE_PREFIX + ': PARTIAL ' + n + '/' + tot, intent.desc + ': ' + n + ' of ' + tot + ' seats are in your cart, the rest failed (' + reason.slice(0, 120) + '). Decide now: pay for ' + n + ' or empty the cart.', AB.BASKET_PATH);
    win.setTimeout(function () { win.location.href = AB.BASKET_PATH; }, 300);
  }
  function succeed(desc, redirect, test) {
    store.del('grab'); store.del('intent'); state.busy = false;
    if (test) {
      store.del('testOnce'); state.testOnce = false;
      store.set('reservedAt', String(Date.now() + AB.TEST_COOLDOWN_MS));
      setAction('TEST OK: ' + desc + ' landed in the cart. EMPTY THE CART now to release it.');
      alarm();
      push('urgent', AB.OWN_TITLE_PREFIX + ' TEST OK', 'The submit path WORKS: ' + desc + ' landed in the cart. Empty the cart now so the ticket is released. Test mode is off; normal rules (2 or 4 adjacent) resume.', AB.BASKET_PATH);
    } else {
      store.set('reservedAt', String(Date.now() + AB.COOLDOWN_MS));
      setAction('RESERVED ' + desc);
      alarm();
      push('urgent', AB.OWN_TITLE_PREFIX + ': RESERVED', 'RESERVED ' + desc + '. Pay NOW on the laptop, the basket hold is about 15 minutes.', AB.BASKET_PATH);
    }
    win.setTimeout(function () { win.location.href = redirect || AB.BASKET_PATH; }, 300);
  }
  function failGrab(intent, reason) {
    var grab = getJSON('grab'); if (grab) { grab.tries = (grab.tries || 0) + 1; grab.nextTryAt = Date.now() + AB.BACKOFF_MS; setJSON('grab', grab); }
    store.del('intent'); state.busy = false;
    var test = !!(intent && intent.test);
    if (test) { store.del('testOnce'); state.testOnce = false; }   // one shot, even on a miss: we have the diagnostic now
    setAction((test ? 'TEST miss: ' : 'miss: ') + reason + ' -> back to watching');
    push(test ? 'urgent' : 'default', AB.OWN_TITLE_PREFIX + (test ? ' TEST FAILED' : ' miss'),
      (intent && intent.name || '') + ': ' + reason + (test ? ' (test mode off; send this to Claude)' : '. Still watching.'), intent && AB.matchPage(intent.pid));
    win.setTimeout(function () { if (pageMode() !== 'list') win.location.href = AB.LIST_PATH; }, 500);
  }

  function keepalive() {
    if (!state.keepalive) return;
    win.fetch(AB.KEEPALIVE_PATH, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { log('keepalive HTTP ' + r.status); }, function (e) { log('keepalive failed ' + e); });
  }

  // ---- boot ----------------------------------------------------------------------
  function boot() {
    mountOverlay();
    state.mode = pageMode();
    heartbeat(); win.setInterval(heartbeat, 5000);
    win.setInterval(render, 5000);
    connectNtfy();
    if (!state.topic) win.setTimeout(function () { var b = doc.getElementById('ab-topic'); if (b) b.onclick(); }, 500);

    if (checkPostSubmit()) { render(); return; }        // landed after a submit
    if (state.mode === 'item') { fulfillItemPage(); render(); return; }
    if (state.mode === 'queue') { setAction('in the waiting room, holding'); render(); return; }
    if (state.mode === 'list') {
      win.setInterval(pollOnce, AB.POLL_MS);
      win.setInterval(keepalive, AB.KEEPALIVE_MS);
      pollOnce();
    }
    render();
  }
  if (doc.body) boot();
  else win.addEventListener('DOMContentLoaded', boot);
})(typeof window !== 'undefined' ? window : globalThis);

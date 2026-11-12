// Tests for the decision logic in autobasket.user.js.  Run:  node test_autobasket.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const AB = require('./autobasket.user.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e) { fail++; console.log('FAIL - ' + name + '\n       ' + ((e && e.message) || e)); }
}

// Two plausible shapes of a resaleItems.json entry. The real one is confirmed from the
// first live capture; the script must cope with both and refuse to send when it cannot.
function siteItem(o) {   // SecuTix-style: ids + movementIds + seatPath
  return Object.assign({
    movementIds: [o.mid], seatCategoryId: o.cat || 501, audienceSubCategoryId: 901, price: o.price || 450,
    seatPath: (o.area || 'B7') + ' / ' + (o.row || '12') + ' / ' + o.seat, availableQuantity: 1,
    seatCategory: { id: o.cat || 501, name: 'Kategori 2' }
  }, o.extra || {});
}
function fixtureItem(o) {  // shape of test-fixtures/items-hit.json (no ids for the request)
  return { itemId: o.mid, seatCategory: 'Kategori 2', area: o.area || 'B7', row: o.row || '12', seat: String(o.seat), price: 450, priceWithCharge: 470, audienceSubCategory: 'Ordinær' };
}
function liveItem(o) {  // real 15/17 Sep capture shape: block + remark "row - seat", price null, realPrice in thousandths,
  // shared `key` per listing row, and the buyer's tariff in pricesSelection ("Resale"), not the ticket's "Adult"
  return { key: o.key || 'NFF_RESALE_10229739619905_10229739913106_10229739620577_10229718202442_10229721214948_10229708951675_10229721164074_null',
    seatCatName: 'Category 3', seatArea: 'KIWI-Bama-svingen', block: o.block || '124', seatCategoryId: 10229721164074,
    audienceSubCategory: 'Adult', quantity: 1, price: null, priceWithCharge: 690000, realPrice: 690000,
    remark: (o.row || '5') + ' - ' + o.seat, itemId: o.mid, audienceSubCategoryId: 10229708951675, movementIds: [o.mid], resaleSeats: [],
    pricesSelection: [{ audienceSubCatId: 10229709001571, audienceSubCatName: 'Resale', audienceSubCatRank: 99, audienceCatKind: 'FULL', priceLevelCode: '', priceLevelId: (o.plId === undefined ? null : o.plId), amount: 690000 }] };
}
const seatsFrom = (items) => AB.expandSeats(AB.normalizeItems({ resaleItems: items }));
const nos = (choice) => choice.seats.map((s) => s.seatNo).sort((a, b) => a - b);

console.log('# alert parsing');
t('resale alert with counts', () => {
  const a = AB.parseAlert({ event: 'message', title: 'TICKETS LISTED on NFF resale!', message: 'Denmark: 2 tickets [B7 r12 s5 Kategori 2 450; B7 r12 s6 Kategori 2 450]. Portugal: 0. Nations League total 2. Open resale.fotball.no now.' });
  assert.deepStrictEqual(a, { kind: 'resale', counts: { Denmark: 2 } });
});
t('resale alert for both matches', () => {
  const a = AB.parseAlert({ title: 'TICKETS LISTED on NFF resale!', message: 'Denmark: 4 tickets. Portugal: 1 tickets. Nations League total 5.' });
  assert.deepStrictEqual(a.counts, { Denmark: 4, Portugal: 1 });
});
t('catalog-only alert has no counts (script then checks both matches)', () => {
  const a = AB.parseAlert({ title: 'TICKETS LISTED on NFF resale!', message: 'Nations League resale shows 1 ticket(s) but none for Denmark or Portugal. Could be the 14 Nov match.' });
  assert.strictEqual(a.kind, 'resale'); assert.deepStrictEqual(a.counts, {});
});
t('main shop alert', () => assert.strictEqual(AB.parseAlert({ title: 'TICKETS ON SALE at billett.fotball.no!', message: 'x' }).kind, 'shop'));
t('heartbeat is ignored', () => assert.strictEqual(AB.parseAlert({ title: 'NFF resale watcher', message: 'Still watching.' }), null));
t('our own pushes are ignored', () => assert.strictEqual(AB.parseAlert({ title: 'Auto-basket: RESERVED', message: 'x' }), null));
t('non-message events are ignored', () => assert.strictEqual(AB.parseAlert({ event: 'keepalive' }), null));

console.log('# place parsing');
t('explicit area/row/seat fields', () => assert.deepStrictEqual(AB.parsePlace({ area: 'B7', row: '12', seat: '5' }), { area: 'B7', row: '12', seatNo: 5, seatLabel: '5' }));
t('seatPath with slashes and words', () => {
  const p = AB.parsePlace({ seatPath: 'Felt 107 / Rad 12 / Sete 5' });
  assert.strictEqual(p.area, 'Felt 107'); assert.strictEqual(p.row, 'Rad 12'); assert.strictEqual(p.seatNo, 5);
});
t('seatPath with dashes and four segments', () => {
  const p = AB.parsePlace({ seatPath: 'Nedre - 107 - 12 - 5' });
  assert.strictEqual(p.area, 'Nedre 107'); assert.strictEqual(p.row, '12'); assert.strictEqual(p.seatNo, 5);
});
t('no place information gives nulls', () => assert.deepStrictEqual(AB.parsePlace({ price: 1 }), { area: null, row: null, seatNo: null, seatLabel: null }));

console.log('# item normalisation');
t('site-style item keeps ids, price, category name and movement ids', () => {
  const it = AB.normalizeItems({ resaleItems: [siteItem({ mid: 77, seat: 5 })] })[0];
  assert.deepStrictEqual(it.movementIds, [77]); assert.strictEqual(it.seatCategoryId, 501);
  assert.strictEqual(it.audienceSubCategoryId, 901); assert.strictEqual(it.price, 450);
  assert.strictEqual(it.category, 'Kategori 2'); assert.strictEqual(it.quantity, 1); assert.strictEqual(it.place.seatNo, 5);
});
t('fixture-style item falls back to itemId and has no request ids', () => {
  const it = AB.normalizeItems({ resaleItems: [fixtureItem({ mid: 9001, seat: 5 })] })[0];
  assert.deepStrictEqual(it.movementIds, [9001]); assert.strictEqual(it.seatCategoryId, undefined);
  assert.strictEqual(it.category, 'Kategori 2'); assert.strictEqual(it.place.area, 'B7');
});
t('single movementId and nested seatCategory.id are accepted', () => {
  const it = AB.normalizeItems({ resaleItems: [{ movementId: 5, seatCategory: { id: 3 }, audienceSubCategory: { id: 4 }, unitAmount: '700,00' }] })[0];
  assert.deepStrictEqual(it.movementIds, [5]); assert.strictEqual(it.seatCategoryId, 3); assert.strictEqual(it.audienceSubCategoryId, 4); assert.strictEqual(it.price, 700);
});
t('real 15 Sep capture: block as area, remark parsed to row/seat, price from realPrice, ids present', () => {
  const it = AB.normalizeItems({ resaleItems: [liveItem({ mid: 10229785519841, row: '5', seat: '844' })] })[0];
  assert.strictEqual(it.place.area, '124');
  assert.strictEqual(it.place.row, '5');
  assert.strictEqual(it.place.seatNo, 844);
  assert.strictEqual(it.category, 'Category 3');
  assert.strictEqual(it.price, 690000);
  assert.deepStrictEqual(it.movementIds, [10229785519841]);
  assert.strictEqual(it.seatCategoryId, 10229721164074);
  assert.strictEqual(it.audienceSubCategoryId, 10229709001571, 'buyer tariff comes from pricesSelection (Resale), not the ticket\'s Adult tariff');
  assert.ok(it.key && it.key.indexOf('NFF_RESALE_') === 0);
});
t('without pricesSelection the ticket\'s own tariff and realPrice are used', () => {
  const raw = liveItem({ mid: 1, row: '5', seat: '844' }); delete raw.pricesSelection;
  const it = AB.normalizeItems({ resaleItems: [raw] })[0];
  assert.strictEqual(it.audienceSubCategoryId, 10229708951675);
  assert.strictEqual(it.price, 690000);
});
const live = (row, ...seatNos) => seatNos.map((n, i) => liveItem({ mid: Number(row) * 1000 + n, row: String(row), seat: String(n) }));
const liveSeats = (items) => AB.expandSeats(AB.normalizeItems({ resaleItems: items }));
t('four real-shape tickets in the same row form a complete, sendable group', () => {
  const c = AB.chooseGroup(liveSeats(live(5, 867, 868, 869, 870)));
  assert.strictEqual(c.count, 4);
  assert.deepStrictEqual(nos(c), [867, 868, 869, 870]);
  const p = AB.buildPayload(10229739913106, c.seats);
  assert.deepStrictEqual(AB.payloadMissing(p), []);
  assert.strictEqual(p.resaleItemData[0].unitAmount, 690000);
  assert.strictEqual(p.resaleItemData.length, 4, 'one entry per seat');
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.movementIds[0]), [5867, 5868, 5869, 5870]);
});
t('real-shape seats one apart in different rows are not a group', () => {
  assert.strictEqual(AB.chooseGroup(liveSeats([liveItem({ mid: 1, row: '5', seat: '844' }), liveItem({ mid: 2, row: '6', seat: '845' })])), null);
});
t('price displays in kroner (thousandths divided)', () => assert.strictEqual(AB.kr(690000), 690));
t('empty and malformed input give no items', () => {
  assert.deepStrictEqual(AB.normalizeItems({ resaleItems: [] }), []);
  assert.deepStrictEqual(AB.normalizeItems(null), []);
  assert.deepStrictEqual(AB.normalizeItems({ resaleItems: [null, 3] }), []);
});

console.log('# seat expansion');
t('one ticket per line becomes one seat', () => assert.strictEqual(seatsFrom([siteItem({ mid: 1, seat: 5 }), siteItem({ mid: 2, seat: 6 })]).length, 2));
t('several tickets behind one line without seat numbers are unverifiable', () => {
  const s = seatsFrom([{ movementIds: [1, 2], availableQuantity: 2, seatCategoryId: 1, audienceSubCategoryId: 1, price: 1, seatPath: 'B7 / 12 / 5' }]);
  assert.strictEqual(s.length, 2); assert.ok(s.every((x) => x.seatNo === null));
});
t('nested seats list is expanded with its own numbers', () => {
  const s = seatsFrom([{ movementIds: [1, 2], seatCategoryId: 1, audienceSubCategoryId: 1, price: 1, area: 'B7', row: '12', seats: [{ movementId: 1, seat: 5 }, { movementId: 2, seat: 6 }] }]);
  assert.deepStrictEqual(s.map((x) => [x.movementId, x.area, x.row, x.seatNo]), [[1, 'B7', '12', 5], [2, 'B7', '12', 6]]);
});
t('a line without any id yields no seat', () => assert.strictEqual(seatsFrom([{ price: 450, seatPath: 'B7 / 12 / 5' }]).length, 0));

console.log('# group selection: 4-8 together, never 1-3, 5 only to avoid stranding a seat');
const S = (...seatNos) => seatsFrom(seatNos.map((n, i) => siteItem({ mid: 100 + i, seat: n })));
const R = (row, ...seatNos) => seatNos.map((n) => siteItem({ mid: Number(row) * 1000 + n, row: String(row), seat: n }));
const G = (...lists) => AB.chooseGroup(seatsFrom([].concat(...lists)));
const rowsOf = (c) => c.rows.map((r) => r[0].row + ':' + r.map((s) => s.seatNo).join(','));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
t('nothing listed', () => assert.strictEqual(AB.chooseGroup([]), null));
t('one, two or three seats are never taken', () => {
  assert.strictEqual(AB.chooseGroup(S(5)), null);
  assert.strictEqual(AB.chooseGroup(S(5, 6)), null);
  assert.strictEqual(AB.chooseGroup(S(5, 6, 7)), null);
});
t('four in a row give 4', () => { const c = AB.chooseGroup(S(5, 6, 7, 8)); assert.strictEqual(c.count, 4); assert.deepStrictEqual(nos(c), [5, 6, 7, 8]); assert.strictEqual(c.rows.length, 1); });
t('five in a row give 5 (4 would leave one seat alone)', () => { const c = AB.chooseGroup(S(5, 6, 7, 8, 9)); assert.strictEqual(c.count, 5); assert.strictEqual(c.orphans, 0); });
for (const n of [6, 7, 8]) {
  t(n + ' in a row give ' + n, () => { const c = AB.chooseGroup(S(...range(1, n))); assert.strictEqual(c.count, n); assert.deepStrictEqual(nos(c), range(1, n)); });
}
t('nine in a row give 7, not 8 (8 would leave one seat alone)', () => {
  const c = AB.chooseGroup(S(...range(1, 9)));
  assert.strictEqual(c.count, 7); assert.strictEqual(c.orphans, 0); assert.deepStrictEqual(nos(c), range(1, 7));
});
t('ten or more in a row give 8 (the most we take), the spare seats together', () => {
  for (const n of [10, 11, 12, 15]) { const c = AB.chooseGroup(S(...range(1, n))); assert.strictEqual(c.count, 8, 'run ' + n); assert.strictEqual(c.orphans, 0, 'run ' + n); }
});
t('seats with a gap are not neighbours', () => assert.strictEqual(AB.chooseGroup(S(1, 2, 4, 5)), null));
t('two pairs in different blocks are not a group (all seats must sit together now)', () => {
  assert.strictEqual(G([siteItem({ mid: 1, seat: 5, area: 'B7' }), siteItem({ mid: 2, seat: 6, area: 'B7' }), siteItem({ mid: 3, seat: 5, area: 'C1' }), siteItem({ mid: 4, seat: 6, area: 'C1' })]), null);
});
t('two pairs in rows far apart in the same block are not a group', () => assert.strictEqual(G(R(12, 5, 6), R(20, 5, 6)), null));
t('2 + 2 directly behind each other give 4', () => {
  const c = G(R(34, 50, 51), R(35, 50, 51));
  assert.strictEqual(c.count, 4); assert.deepStrictEqual(rowsOf(c), ['34:50,51', '35:50,51']);
});
t('the example: row 34 seats 50-52 and row 35 seats 50-52 give 6', () => {
  const c = G(R(34, 50, 51, 52), R(35, 50, 51, 52));
  assert.strictEqual(c.count, 6); assert.deepStrictEqual(rowsOf(c), ['34:50,51,52', '35:50,51,52']);
});
t('"or nearby": row 35 shifted two seats still counts', () => assert.strictEqual(G(R(34, 50, 51, 52), R(35, 52, 53, 54)).count, 6));
t('rows behind each other but far apart in seat numbers are not a group', () => assert.strictEqual(G(R(34, 50, 51), R(35, 80, 81)), null));
t('3 + 2 behind each other give 5 (4 would strand a seat)', () => {
  const c = G(R(34, 50, 51, 52), R(35, 50, 51));
  assert.strictEqual(c.count, 5); assert.strictEqual(c.rows.length, 2); assert.strictEqual(c.orphans, 0);
});
t('5 is never taken when it would itself strand a seat', () => {
  assert.strictEqual(AB.fitRuns([S(1, 2, 3, 4, 5, 6)]).count, 6);
  assert.strictEqual(AB.ALLOWED.indexOf(5), -1);
});
t('a single seat in the row behind is not used', () => assert.strictEqual(G(R(34, 50, 51, 52), R(35, 51)), null));
t('three rows of 2 give 6', () => assert.strictEqual(G(R(10, 5, 6), R(11, 5, 6), R(12, 5, 6)).count, 6));
t('three rows of 4 give 8 at most', () => {
  const c = G(R(10, 5, 6, 7, 8), R(11, 5, 6, 7, 8), R(12, 5, 6, 7, 8));
  assert.strictEqual(c.count, 8); assert.ok(c.rows.every((r) => r.length >= 2));
});
t('four rows are not chained (at most three)', () => {
  const c = G(R(10, 5, 6), R(11, 5, 6), R(12, 5, 6), R(13, 5, 6));
  assert.strictEqual(c.count, 6); assert.strictEqual(c.rows.length, 3);
});
t('same count: one row beats rows behind each other', () => {
  const c = G(R(1, 10, 11, 12, 13), R(20, 5, 6), R(21, 5, 6));
  assert.strictEqual(c.count, 4); assert.deepStrictEqual(rowsOf(c), ['1:10,11,12,13']);
});
t('more seats beat one row: 6 over two rows beat 4 in one row', () => {
  const c = G(R(1, 10, 11, 12, 13), R(20, 5, 6, 7), R(21, 5, 6, 7));
  assert.strictEqual(c.count, 6); assert.strictEqual(c.rows.length, 2);
});
t('4 + 4 behind each other give 8, not just the 4 in one row', () => assert.strictEqual(G(R(34, 50, 51, 52, 53), R(35, 50, 51, 52, 53)).count, 8));
t('many seats in two rows: 6 + 6 give 8 as 4 + 4, behind each other, no lone seat', () => {
  const c = G(R(34, ...range(40, 45)), R(35, ...range(40, 45)));
  assert.strictEqual(c.count, 8);
  assert.deepStrictEqual(c.rows.map((r) => r.length), [4, 4]);
  assert.strictEqual(c.orphans, 0);
  assert.ok(c.spread <= 1, 'spread ' + c.spread);
});
t('a full row of 8 beats 4 + 4 over two rows', () => {
  const c = G(R(34, ...range(40, 49)), R(35, ...range(40, 49)));
  assert.strictEqual(c.count, 8); assert.strictEqual(c.rows.length, 1);
});
t('same count: the cheaper group wins', () => {
  const c = AB.chooseGroup(seatsFrom([...R(1, 1, 2, 3, 4).map((x) => Object.assign(x, { price: 900 })), ...R(2, 11, 12, 13, 14)]));
  assert.strictEqual(c.seats[0].row, '2');
});
t('unnumbered tickets are never taken', () => {
  assert.strictEqual(AB.chooseGroup(seatsFrom([{ movementIds: [1, 2, 3, 4], availableQuantity: 4, seatCategoryId: 1, audienceSubCategoryId: 1, price: 1 }])), null);
});
t('duplicate listings of the same seat do not count twice', () => assert.strictEqual(AB.chooseGroup(S(5, 5, 6, 7)), null));
t('a group the seat map showed apart (skip list) is passed over for the next best', () => {
  const seats = seatsFrom([...R(34, 50, 51, 52), ...R(35, 50, 51, 52), ...R(3, 1, 2, 3, 4)]);
  const first = AB.chooseGroup(seats);
  assert.strictEqual(first.count, 6);
  const next = AB.chooseGroup(seats, [AB.seatKey(first)]);
  assert.strictEqual(next.count, 4); assert.strictEqual(next.seats[0].row, '3');
});
t('ignored movement ids (known unbuyable listing) are never chosen', () => {
  const old = AB.IGNORE_MOVEMENTS; AB.IGNORE_MOVEMENTS = ['100', '101'];
  try {
    assert.strictEqual(AB.chooseGroup(S(5, 6, 7, 8)), null, 'only 7-8 left');
    const c = AB.chooseGroup(S(5, 6, 7, 8, 9, 10));
    assert.deepStrictEqual(nos(c), [7, 8, 9, 10]);
  } finally { AB.IGNORE_MOVEMENTS = old; }
});
t('ignored seat positions (known unbuyable seats) are never chosen', () => {
  const old = AB.IGNORE_SEATS; AB.IGNORE_SEATS = ['B7 r12 s5', 'B7 r12 s6'];
  try {
    assert.strictEqual(AB.chooseGroup(S(5, 6, 7, 8)), null);
    assert.deepStrictEqual(nos(AB.chooseGroup(S(5, 6, 7, 8, 9, 10))), [7, 8, 9, 10]);
  } finally { AB.IGNORE_SEATS = old; }
});
t('the September ghost lists (other matches) are cleared', () => {
  assert.deepStrictEqual(AB.IGNORE_SEATS, []); assert.deepStrictEqual(AB.IGNORE_MOVEMENTS, []);
});
t('seatPos prints the trace / ignore-list format', () => assert.strictEqual(AB.seatPos({ area: '412', row: '31', seatNo: 479 }), '412 r31 s479'));
t('excluded sections are skipped', () => {
  const old = AB.EXCLUDE_AREA; AB.EXCLUDE_AREA = /^B7$/;
  try { assert.strictEqual(AB.chooseGroup(S(5, 6, 7, 8)), null); } finally { AB.EXCLUDE_AREA = old; }
});

console.log('# seat-map check: are the rows really behind each other?');
const P = (row, seatNo, x, y) => ({ row: String(row), seatNo, x, y });
t('rows straight behind each other are together', () => {
  const r = AB.rowsNear([P(34, 50, 0, 0), P(34, 51, 10, 0), P(34, 52, 20, 0), P(35, 50, 0, 12), P(35, 51, 10, 12), P(35, 52, 20, 12)]);
  assert.strictEqual(r.ok, true, r.why);
});
t('rows shifted a couple of seats are still together', () => {
  assert.strictEqual(AB.rowsNear([P(34, 50, 0, 0), P(34, 51, 10, 0), P(35, 60, 20, 12), P(35, 61, 30, 12)]).ok, true);
});
t('rows far apart on the map are apart, even with matching seat numbers', () => {
  const r = AB.rowsNear([P(34, 50, 0, 0), P(34, 51, 10, 0), P(35, 50, 200, 12), P(35, 51, 210, 12)]);
  assert.strictEqual(r.ok, false); assert.ok(/seat widths apart/.test(r.why), r.why);
});
t('missing coordinates cannot be measured (null, not a verdict)', () => {
  assert.strictEqual(AB.rowsNear([P(34, 50, 0, 0), P(35, 50, undefined, undefined)]).ok, null);
  assert.strictEqual(AB.rowsNear([]).ok, null);
});

console.log('# match id from a pasted URL');
t('performanceId from a resale match URL', () => assert.strictEqual(AB.parseMatchId('https://resale.fotball.no/selection/resale/item?performanceId=10229739913107&checkResaleAvailability=true'), '10229739913107'));
t('perfId from a main-shop URL', () => assert.strictEqual(AB.parseMatchId('https://billett.fotball.no/selection/event/seat?perfId=10229739913199&lang=en'), '10229739913199'));
t('a bare id', () => assert.strictEqual(AB.parseMatchId('  10229739913199 '), '10229739913199'));
t('a productId is not a match id', () => assert.strictEqual(AB.parseMatchId('https://billett.fotball.no/selection/event/date?productId=10229739619905'), null));
t('the 14 Nov match is configured', () => assert.deepStrictEqual(AB.MATCHES, { '10229739913108': 'NL 14 Nov' }));

console.log('# basket request');
t('payload is one entry PER SEAT (quantity 1 each), as the seated page posts it', () => {
  const c = AB.chooseGroup(S(5, 6, 7, 8));
  const p = AB.buildPayload('10229739913106', c.seats);
  assert.strictEqual(p.performanceId, 10229739913106);
  assert.strictEqual(p.resaleItemData.length, 4);
  assert.deepStrictEqual(p.resaleItemData[0], { key: null, audienceSubCategoryId: 901, seatCategoryId: 501, priceLevelId: null, quantity: 1, unitAmount: 450, movementIds: [100] });
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.movementIds[0]), [100, 101, 102, 103]);
  assert.ok(p.resaleItemData.every((d) => d.quantity === 1 && d.movementIds.length === 1));
  assert.deepStrictEqual(AB.payloadMissing(p), []);
});
t('pairs with different prices become separate entries', () => {
  const c = { seats: seatsFrom([siteItem({ mid: 1, seat: 5 }), siteItem({ mid: 2, seat: 6 }), siteItem({ mid: 3, seat: 20, row: '3', price: 700, cat: 502 }), siteItem({ mid: 4, seat: 21, row: '3', price: 700, cat: 502 })]) };
  const p = AB.buildPayload(1, c.seats);
  assert.strictEqual(p.resaleItemData.length, 4);
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.quantity), [1, 1, 1, 1]);
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.unitAmount), [450, 450, 700, 700]);
});
t('fixture-shaped listing is recognised as a pair but the request is reported incomplete, not sent', () => {
  const raw = JSON.parse(fs.readFileSync(__dirname + '/test-fixtures/items-hit.json', 'utf8'));
  const seats = AB.expandSeats(AB.normalizeItems(raw));
  const c = ({ count: seats.length, seats });
  assert.strictEqual(c.count, 2);
  const missing = AB.payloadMissing(AB.buildPayload(10229739913106, c.seats));
  assert.deepStrictEqual(missing.sort(), ['audienceSubCategoryId', 'seatCategoryId']);
});
t('empty payload is incomplete', () => assert.deepStrictEqual(AB.payloadMissing({ performanceId: 1, resaleItemData: [] }), ['resaleItemData']));
t('form body mirrors the match page fields and carries the csrf', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 111, row: '5', seat: '844' }), liveItem({ mid: 112, row: '5', seat: '845' })] }));
  const body = AB.buildFormBody(AB.buildPayload(10229739913106, ({ count: seats.length, seats }).seats), 'tok-123');
  assert.ok(body.indexOf('performanceId=10229739913106') === 0, body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.key=NFF_RESALE_') > 0, 'form carries the row key: ' + body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.audienceSubCategoryId=10229709001571') > 0, 'form carries the Resale tariff: ' + body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.seatCategoryId=10229721164074') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.quantity=1') > 0, 'each seat is its own entry of quantity 1: ' + body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.unitAmount=690000') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.movementIds%5B0%5D=111') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B1%5D.movementIds%5B0%5D=112') > 0, 'second seat is entry [1]: ' + body);
  assert.ok(body.indexOf('resaleItemData%5B1%5D.quantity=1') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B1%5D.key=NFF_RESALE_') > 0, 'both entries carry the shared key: ' + body);
  assert.strictEqual(body.indexOf('quantity=2'), -1, 'never a quantity-2 entry on the seated page');
  assert.ok(body.endsWith('_csrf=tok-123'), body);
});
t('two rows (different keys and prices) make two form entries', () => {
  const dear = { pricesSelection: [{ audienceSubCatId: 10229709001571, amount: 990000 }], realPrice: 990000, priceWithCharge: 990000, seatCategoryId: 55 };
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [
    liveItem({ mid: 1, row: '5', seat: '10' }), liveItem({ mid: 2, row: '5', seat: '11' }),
    Object.assign(liveItem({ mid: 3, row: '9', seat: '20', key: 'NFF_RESALE_ROW_B' }), dear),
    Object.assign(liveItem({ mid: 4, row: '9', seat: '21', key: 'NFF_RESALE_ROW_B' }), dear)] }));
  const payload = AB.buildPayload(1, ({ count: seats.length, seats }).seats);
  assert.strictEqual(payload.resaleItemData.length, 4, 'two pairs = four seat entries');
  const body = AB.buildFormBody(payload, 'x');
  assert.ok(body.indexOf('resaleItemData%5B2%5D.unitAmount=990000') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B2%5D.key=NFF_RESALE_ROW_B') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B3%5D.key=NFF_RESALE_ROW_B') > 0, body);
});
t('the real 17 Sep Portugal pair (one key, two seats) becomes TWO entries of quantity 1 sharing the key', () => {
  const k = 'NFF_RESALE_10229739619905_10229739913107_10229739620585_10229718202440_10229721214995_10229708951675_10229721164073_null';
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [
    Object.assign(liveItem({ mid: 10229796417629, row: '27', seat: '417', key: k, block: '411' }), { seatCategoryId: 10229721164073, realPrice: 890000, pricesSelection: [{ audienceSubCatId: 10229709001571, amount: 890000 }] }),
    Object.assign(liveItem({ mid: 10229796417630, row: '27', seat: '418', key: k, block: '411' }), { seatCategoryId: 10229721164073, realPrice: 890000, pricesSelection: [{ audienceSubCatId: 10229709001571, amount: 890000 }] })] }));
  const c = ({ count: seats.length, seats });
  assert.strictEqual(c.count, 2);
  const p = AB.buildPayload(10229739913107, c.seats);
  assert.strictEqual(p.resaleItemData.length, 2);
  assert.deepStrictEqual(p.resaleItemData[0], { key: k, audienceSubCategoryId: 10229709001571, seatCategoryId: 10229721164073, priceLevelId: null, quantity: 1, unitAmount: 890000, movementIds: [10229796417629] });
  assert.deepStrictEqual(p.resaleItemData[1], { key: k, audienceSubCategoryId: 10229709001571, seatCategoryId: 10229721164073, priceLevelId: null, quantity: 1, unitAmount: 890000, movementIds: [10229796417630] });
  assert.deepStrictEqual(AB.payloadMissing(p), []);
});
t('a null priceLevelId is OMITTED from the form (the proven 17 Sep single carried none), key is kept', () => {
  const k = 'NFF_RESALE_ROW_X';
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [
    liveItem({ mid: 1, row: '5', seat: '10', key: k }), liveItem({ mid: 2, row: '5', seat: '11', key: k })] }));
  const body = AB.buildFormBody(AB.buildPayload(1, ({ count: seats.length, seats }).seats), 'tok');
  assert.strictEqual(body.indexOf('priceLevelId'), -1, 'no empty priceLevelId field: ' + body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.key=NFF_RESALE_ROW_X') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.seatCategoryId=') > 0, body);
});
t('a non-null priceLevelId is carried through and posted', () => {
  const it = AB.normalizeItems({ resaleItems: [liveItem({ mid: 1, row: '5', seat: '10', plId: 777 })] })[0];
  assert.strictEqual(it.priceLevelId, 777);
  const body = AB.buildFormBody(AB.buildPayload(1, AB.expandSeats([it])), 'tok');
  assert.ok(body.indexOf('resaleItemData%5B0%5D.priceLevelId=777') > 0, body);
  assert.strictEqual(AB.buildPayload(1, []).resaleItemData.length, 0);
});
console.log('# one-off smoke test chooser (reserve 1 ticket to prove the submit path)');
t('chooseAny picks one ticket with an id, numbered seats first', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [
    { movementIds: [1, 2], availableQuantity: 2, seatCategoryId: 1, audienceSubCategoryId: 1, realPrice: 100 },   // unnumbered bundle
    liveItem({ mid: 77, row: '5', seat: '844' })] }));
  const c = AB.chooseAny(seats, 1);
  assert.strictEqual(c.count, 1);
  assert.strictEqual(c.seats[0].movementId, 77);
  assert.deepStrictEqual(AB.payloadMissing(AB.buildPayload(1, c.seats)), []);
});
t('chooseAny returns null when nothing has an id', () => assert.strictEqual(AB.chooseAny([], 1), null));
t('a single real listing gives no pair but is a valid 1-ticket test target', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 5, row: '5', seat: '844' })] }));
  assert.strictEqual(AB.chooseGroup(seats), null, 'never 1 in normal mode');
  const c = AB.chooseAny(seats, 1);
  const p = AB.buildPayload(10229739913106, c.seats);
  assert.strictEqual(p.resaleItemData[0].quantity, 1);
  assert.ok(p.resaleItemData[0].key.indexOf('NFF_RESALE_') === 0);
});
console.log('# one seat per submit: a pair becomes a queue of single-seat payloads');
t('singlePayloads turns a chosen pair into two single-seat payloads, each complete', () => {
  const k = 'NFF_RESALE_ROW_Q';
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 501, row: '60', seat: '975', key: k }), liveItem({ mid: 502, row: '60', seat: '976', key: k })] }));
  const c = ({ count: seats.length, seats });
  const q = AB.singlePayloads(10229739913106, c.seats);
  assert.strictEqual(q.length, 2);
  q.forEach((p) => {
    assert.strictEqual(p.performanceId, 10229739913106);
    assert.strictEqual(p.resaleItemData.length, 1, 'exactly one row per submit');
    assert.strictEqual(p.resaleItemData[0].quantity, 1);
    assert.strictEqual(p.resaleItemData[0].key, k);
    assert.deepStrictEqual(AB.payloadMissing(p), []);
  });
  assert.deepStrictEqual(q.map((p) => p.resaleItemData[0].movementIds[0]), [501, 502]);
});
t('singlePayloads for four seats gives four submits in seat order', () => {
  const c = AB.chooseGroup(S(5, 6, 7, 8));
  const q = AB.singlePayloads(1, c.seats);
  assert.strictEqual(q.length, 4);
  assert.deepStrictEqual(q.map((p) => p.resaleItemData[0].movementIds[0]), [100, 101, 102, 103]);
});
t('checkout steps count as a successful landing', () => {
  assert.strictEqual(AB.pageMode('/checkout/beneficiaries', 'Checkout'), 'cart');
  assert.strictEqual(AB.pageMode('/cart/shoppingCart', 'Cart'), 'cart');
});

console.log('# texts');
t('group description names section, row, seats, category and price', () => {
  assert.strictEqual(AB.describeGroup(AB.chooseGroup(S(5, 6, 7, 8))), 'B7 row 12 seats 5-8 Kategori 2 450 kr');
});
t('group description shows kroner for a real thousandths price', () => {
  assert.strictEqual(AB.describeGroup(AB.chooseGroup(liveSeats(live(5, 867, 868, 869, 870)))), '124 row 5 seats 867-870 Category 3 690 kr');
});
t('a multi-row group is described row by row', () => {
  assert.strictEqual(AB.describeGroup(G(R(34, 50, 51, 52), R(35, 50, 51, 52))), 'B7 row 34 seats 50-52 + row 35 seats 50-52 Kategori 2 450 kr');
});
t('mixed prices are all shown', () => {
  const c = AB.chooseGroup(seatsFrom([...R(5, 1, 2), ...R(5, 3, 4).map((x) => Object.assign(x, { price: 700 }))]));
  assert.ok(AB.describeGroup(c).endsWith('450/700 kr'), AB.describeGroup(c));
});
t('describeAll lists EVERY seat, sorted and grouped per block and row (12 Nov: 24 of 30 were hidden)', () => {
  const seats = seatsFrom([
    siteItem({ mid: 1, area: '409', row: '26', seat: 344, price: 690 }), siteItem({ mid: 2, area: '103', row: '12', seat: 90, price: 990 }),
    siteItem({ mid: 3, area: '103', row: '8', seat: 70, price: 990 }), siteItem({ mid: 4, area: '103', row: '12', seat: 77, price: 990 }),
    { movementIds: [9], seatCategoryId: 1, audienceSubCategoryId: 1, price: 1 }]);
  assert.strictEqual(AB.describeAll(seats), '103 r8 s70 990; 103 r12 s77,90 990; 409 r26 s344 690; ? unnumbered x1');
});
t('describeAll stays under the ntfy size limit', () => {
  const many = seatsFrom(range(1, 400).map((n) => siteItem({ mid: n, area: String(100 + (n % 40)), row: String(n % 30), seat: n })));
  const d = AB.describeAll(many);
  assert.ok(d.length < 3100, 'length ' + d.length); assert.ok(/more rows$/.test(d), d.slice(-40));
});
t('mostTogether reports the biggest run in one row', () => {
  const m = AB.mostTogether(seatsFrom([...R(12, 77, 89, 90), ...R(8, 70)]));
  assert.deepStrictEqual(m, { n: 2, desc: 'B7 r12 s89-90' });
  assert.deepStrictEqual(AB.mostTogether([]), { n: 0, desc: '-' });
});
console.log('# polling pace, bot wall, held seats');
t('polls every 1.2-1.8 s normally', () => {
  assert.strictEqual(AB.nextPollDelay(1000, 0, 0), 1200);
  assert.strictEqual(AB.nextPollDelay(1000, 0, 0.5), 1500);
  assert.strictEqual(AB.nextPollDelay(1000, 0, 0.999999), 1800);
  for (let i = 0; i < 200; i++) { const d = AB.nextPollDelay(1000, 0, Math.random()); assert.ok(d >= 1200 && d <= 1800, d); }
});
t('polls at the safe 3 s while recovering from the bot wall, fast again after', () => {
  assert.strictEqual(AB.nextPollDelay(1000, 5000, 0.5), 3000);
  assert.strictEqual(AB.nextPollDelay(6000, 5000, 0.5), 1500);
});
t('bot-wall answers are recognised, ordinary blips are not', () => {
  ['HTTP 403', 'HTTP 429', 'captcha', 'non-JSON'].forEach((e) => assert.strictEqual(AB.isBotWall(e), true, e));
  ['HTTP 500', 'login', 'waiting room', 'TypeError: Failed to fetch'].forEach((e) => assert.strictEqual(AB.isBotWall(e), false, e));
});
t('the two 12 Nov "held by someone else" pages are recognised', () => {
  assert.ok(AB.isHeldText("Error Unfortunately, you're a little too late. The ticket(s) are currently in someone else's basket. If they"));
  assert.ok(AB.isHeldText('Product not available Sorry, your selected product is not available in resale channel. Please continue shopping'));
  assert.ok(!AB.isHeldText('Sorry, we are unable to process your request at the moment.'));
  assert.ok(!AB.isHeldText(''));
});
t('raw sample shows the first listing entry, capped', () => {
  assert.strictEqual(AB.rawSample({ resaleItems: [{ a: 1 }, { b: 2 }] }), '{"a":1}');
  assert.strictEqual(AB.rawSample({ resaleItems: [] }), '');
  assert.ok(AB.rawSample({ resaleItems: [{ x: 'y'.repeat(2000) }] }).length <= 703);
});
t('seat description caps the list', () => {
  const d = AB.describeSeats(S(1, 3, 5, 7, 9, 11, 13, 15));
  assert.ok(d.endsWith('+2 more'), d);
});
t('match page link carries the performance id', () => assert.ok(AB.matchPage('10229739913107').indexOf('performanceId=10229739913107') > 0));

console.log('# page mode + intent (state machine across the queue navigation)');
t('list page is recognised', () => assert.strictEqual(AB.pageMode('/list/resaleProducts/', 'Mens Nations League'), 'list'));
t('the new /list/events landing page (25 Sep redirect target) is also the list page', () => assert.strictEqual(AB.pageMode('/list/events', 'Nations League'), 'list'));
t('the secured item page path is still the item page', () => assert.strictEqual(AB.pageMode('/secured/selection/resale/item', 'Item selection'), 'item'));
t('item page is recognised', () => assert.strictEqual(AB.pageMode('/selection/resale/item', 'Item selection'), 'item'));
t('cart page is recognised', () => assert.strictEqual(AB.pageMode('/cart/shoppingCart', 'Cart'), 'cart'));
t('the waiting room is recognised by title', () => assert.strictEqual(AB.pageMode('/anything', 'Waiting Room'), 'queue'));
t('the cookie/queue interstitial is recognised', () => assert.strictEqual(AB.pageMode('/cookieWarning', 'Cookies appear to be disabled in your browser.'), 'queue'));
t('an unrelated page is other', () => assert.strictEqual(AB.pageMode('/account/login', 'Login'), 'other'));
t('a fresh intent is fresh, an old one is not', () => {
  var now = 1000000;
  assert.strictEqual(AB.intentFresh({ pid: '1', createdAt: now - 1000 }, now, 3000), true);
  assert.strictEqual(AB.intentFresh({ pid: '1', createdAt: now - 9000 }, now, 3000), false);
  assert.strictEqual(AB.intentFresh(null, now, 3000), false);
  assert.strictEqual(AB.intentFresh({ pid: '1' }, now, 3000), false);
});
t('seat key is stable and identifies the exact ticket set', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 22, row: '5', seat: '844' }), liveItem({ mid: 11, row: '5', seat: '845' })] }));
  assert.strictEqual(AB.seatKey({ seats }), '11,22');
  assert.strictEqual(AB.seatKey(null), '');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

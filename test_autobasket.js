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
t('two real-shape tickets in the same row form a complete, sendable pair', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 1, row: '5', seat: '844' }), liveItem({ mid: 2, row: '5', seat: '845' })] }));
  const c = AB.choosePairs(seats);
  assert.strictEqual(c.count, 2);
  assert.deepStrictEqual(nos(c), [844, 845]);
  const p = AB.buildPayload(10229739913106, c.seats);
  assert.deepStrictEqual(AB.payloadMissing(p), []);
  assert.strictEqual(p.resaleItemData[0].unitAmount, 690000);
  assert.strictEqual(p.resaleItemData.length, 2, 'one entry per seat');
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.movementIds[0]), [1, 2]);
});
t('real-shape seats one apart in different rows are not a pair', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 1, row: '5', seat: '844' }), liveItem({ mid: 2, row: '6', seat: '845' })] }));
  assert.strictEqual(AB.choosePairs(seats), null);
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

console.log('# pair selection: never 1 or 3, adjacent only');
const S = (...seatNos) => seatsFrom(seatNos.map((n, i) => siteItem({ mid: 100 + i, seat: n })));
t('nothing listed', () => assert.strictEqual(AB.choosePairs([]), null));
t('one seat is never taken', () => assert.strictEqual(AB.choosePairs(S(5)), null));
t('two adjacent seats give 2', () => { const c = AB.choosePairs(S(5, 6)); assert.strictEqual(c.count, 2); assert.deepStrictEqual(nos(c), [5, 6]); });
t('two seats with a gap are not a pair', () => assert.strictEqual(AB.choosePairs(S(5, 7)), null));
t('two seats in different rows are not a pair', () => {
  assert.strictEqual(AB.choosePairs(seatsFrom([siteItem({ mid: 1, seat: 5, row: '12' }), siteItem({ mid: 2, seat: 6, row: '13' })])), null);
});
t('two seats in different sections with neighbouring numbers are not a pair', () => {
  assert.strictEqual(AB.choosePairs(seatsFrom([siteItem({ mid: 1, seat: 5, area: 'B7' }), siteItem({ mid: 2, seat: 6, area: 'B8' })])), null);
});
t('three in a row give one pair (2), never 3', () => { const c = AB.choosePairs(S(5, 6, 7)); assert.strictEqual(c.count, 2); assert.deepStrictEqual(nos(c), [5, 6]); });
t('four in a row give 4', () => { const c = AB.choosePairs(S(5, 6, 7, 8)); assert.strictEqual(c.count, 4); assert.deepStrictEqual(nos(c), [5, 6, 7, 8]); assert.strictEqual(c.pairs.length, 2); });
t('two pairs in different places give 4', () => {
  const c = AB.choosePairs(seatsFrom([siteItem({ mid: 1, seat: 5, area: 'B7' }), siteItem({ mid: 2, seat: 6, area: 'B7' }), siteItem({ mid: 3, seat: 20, area: 'C1', row: '3' }), siteItem({ mid: 4, seat: 21, area: 'C1', row: '3' })]));
  assert.strictEqual(c.count, 4); assert.strictEqual(c.pairs.length, 2);
});
t('five seats: run of three plus a pair elsewhere give 4', () => {
  const c = AB.choosePairs(seatsFrom([siteItem({ mid: 1, seat: 5 }), siteItem({ mid: 2, seat: 6 }), siteItem({ mid: 3, seat: 7 }), siteItem({ mid: 4, seat: 30, row: '2' }), siteItem({ mid: 5, seat: 31, row: '2' })]));
  assert.strictEqual(c.count, 4); assert.deepStrictEqual(nos(c), [5, 6, 30, 31]);
});
t('six in a row give 4, not 6', () => { const c = AB.choosePairs(S(1, 2, 3, 4, 5, 6)); assert.strictEqual(c.count, 4); assert.deepStrictEqual(nos(c), [1, 2, 3, 4]); });
t('four in a row are preferred over two separate pairs', () => {
  const c = AB.choosePairs(seatsFrom([siteItem({ mid: 1, seat: 1, area: 'A' }), siteItem({ mid: 2, seat: 2, area: 'A' }), siteItem({ mid: 3, seat: 10, area: 'B' }), siteItem({ mid: 4, seat: 11, area: 'B' }), siteItem({ mid: 5, seat: 12, area: 'B' }), siteItem({ mid: 6, seat: 13, area: 'B' })]));
  assert.deepStrictEqual(c.seats.map((s) => s.area), ['B', 'B', 'B', 'B']);
});
t('unnumbered tickets are never taken', () => {
  assert.strictEqual(AB.choosePairs(seatsFrom([{ movementIds: [1, 2, 3, 4], availableQuantity: 4, seatCategoryId: 1, audienceSubCategoryId: 1, price: 1 }])), null);
});
t('duplicate listing of the same seat does not form a pair with itself', () => assert.strictEqual(AB.choosePairs(S(5, 5)), null));
t('a want list of [2] takes one pair even when four are there', () => assert.strictEqual(AB.choosePairs(S(5, 6, 7, 8), [2]).count, 2));
t('excluded sections are skipped', () => {
  const old = AB.EXCLUDE_AREA; AB.EXCLUDE_AREA = /^B7$/;
  try { assert.strictEqual(AB.choosePairs(S(5, 6)), null); } finally { AB.EXCLUDE_AREA = old; }
});

console.log('# basket request');
t('payload is one entry PER SEAT (quantity 1 each), as the seated page posts it', () => {
  const c = AB.choosePairs(S(5, 6, 7, 8));
  const p = AB.buildPayload('10229739913106', c.seats);
  assert.strictEqual(p.performanceId, 10229739913106);
  assert.strictEqual(p.resaleItemData.length, 4);
  assert.deepStrictEqual(p.resaleItemData[0], { key: null, audienceSubCategoryId: 901, seatCategoryId: 501, priceLevelId: null, quantity: 1, unitAmount: 450, movementIds: [100] });
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.movementIds[0]), [100, 101, 102, 103]);
  assert.ok(p.resaleItemData.every((d) => d.quantity === 1 && d.movementIds.length === 1));
  assert.deepStrictEqual(AB.payloadMissing(p), []);
});
t('pairs with different prices become separate entries', () => {
  const c = AB.choosePairs(seatsFrom([siteItem({ mid: 1, seat: 5 }), siteItem({ mid: 2, seat: 6 }), siteItem({ mid: 3, seat: 20, row: '3', price: 700, cat: 502 }), siteItem({ mid: 4, seat: 21, row: '3', price: 700, cat: 502 })]));
  const p = AB.buildPayload(1, c.seats);
  assert.strictEqual(p.resaleItemData.length, 4);
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.quantity), [1, 1, 1, 1]);
  assert.deepStrictEqual(p.resaleItemData.map((d) => d.unitAmount), [450, 450, 700, 700]);
});
t('fixture-shaped listing is recognised as a pair but the request is reported incomplete, not sent', () => {
  const raw = JSON.parse(fs.readFileSync(__dirname + '/test-fixtures/items-hit.json', 'utf8'));
  const seats = AB.expandSeats(AB.normalizeItems(raw));
  const c = AB.choosePairs(seats);
  assert.strictEqual(c.count, 2);
  const missing = AB.payloadMissing(AB.buildPayload(10229739913106, c.seats));
  assert.deepStrictEqual(missing.sort(), ['audienceSubCategoryId', 'seatCategoryId']);
});
t('empty payload is incomplete', () => assert.deepStrictEqual(AB.payloadMissing({ performanceId: 1, resaleItemData: [] }), ['resaleItemData']));
t('form body mirrors the match page fields and carries the csrf', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 111, row: '5', seat: '844' }), liveItem({ mid: 112, row: '5', seat: '845' })] }));
  const body = AB.buildFormBody(AB.buildPayload(10229739913106, AB.choosePairs(seats).seats), 'tok-123');
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
  const payload = AB.buildPayload(1, AB.choosePairs(seats).seats);
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
  const c = AB.choosePairs(seats);
  assert.strictEqual(c.count, 2);
  const p = AB.buildPayload(10229739913107, c.seats);
  assert.strictEqual(p.resaleItemData.length, 2);
  assert.deepStrictEqual(p.resaleItemData[0], { key: k, audienceSubCategoryId: 10229709001571, seatCategoryId: 10229721164073, priceLevelId: null, quantity: 1, unitAmount: 890000, movementIds: [10229796417629] });
  assert.deepStrictEqual(p.resaleItemData[1], { key: k, audienceSubCategoryId: 10229709001571, seatCategoryId: 10229721164073, priceLevelId: null, quantity: 1, unitAmount: 890000, movementIds: [10229796417630] });
  assert.deepStrictEqual(AB.payloadMissing(p), []);
});
t('the form body carries priceLevelId (empty when null) and key, matching the page addToCart', () => {
  const k = 'NFF_RESALE_ROW_X';
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [
    liveItem({ mid: 1, row: '5', seat: '10', key: k }), liveItem({ mid: 2, row: '5', seat: '11', key: k })] }));
  const body = AB.buildFormBody(AB.buildPayload(1, AB.choosePairs(seats).seats), 'tok');
  assert.ok(body.indexOf('resaleItemData%5B0%5D.priceLevelId=&') > 0 || body.indexOf('resaleItemData%5B0%5D.priceLevelId=') > 0, 'priceLevelId field present: ' + body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.key=NFF_RESALE_ROW_X') > 0, body);
  assert.ok(body.indexOf('resaleItemData%5B0%5D.seatCategoryId=') > 0, body);
});
t('a non-null priceLevelId is carried through', () => {
  const it = AB.normalizeItems({ resaleItems: [liveItem({ mid: 1, row: '5', seat: '10', plId: 777 })] })[0];
  assert.strictEqual(it.priceLevelId, 777);
  assert.strictEqual(AB.buildPayload(1, AB.expandSeats([]).concat()).resaleItemData.length, 0);
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
  assert.strictEqual(AB.choosePairs(seats), null, 'never 1 in normal mode');
  const c = AB.chooseAny(seats, 1);
  const p = AB.buildPayload(10229739913106, c.seats);
  assert.strictEqual(p.resaleItemData[0].quantity, 1);
  assert.ok(p.resaleItemData[0].key.indexOf('NFF_RESALE_') === 0);
});
console.log('# one seat per submit: a pair becomes a queue of single-seat payloads');
t('singlePayloads turns a chosen pair into two single-seat payloads, each complete', () => {
  const k = 'NFF_RESALE_ROW_Q';
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 501, row: '60', seat: '975', key: k }), liveItem({ mid: 502, row: '60', seat: '976', key: k })] }));
  const c = AB.choosePairs(seats);
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
  const c = AB.choosePairs(S(5, 6, 7, 8));
  const q = AB.singlePayloads(1, c.seats);
  assert.strictEqual(q.length, 4);
  assert.deepStrictEqual(q.map((p) => p.resaleItemData[0].movementIds[0]), [100, 101, 102, 103]);
});
t('checkout steps count as a successful landing', () => {
  assert.strictEqual(AB.pageMode('/checkout/beneficiaries', 'Checkout'), 'cart');
  assert.strictEqual(AB.pageMode('/cart/shoppingCart', 'Cart'), 'cart');
});

console.log('# texts');
t('pair description names section, row, seats, category and price', () => {
  const c = AB.choosePairs(S(5, 6));
  assert.strictEqual(AB.describePairs(c.pairs), 'B7 row 12 seats 5-6 Kategori 2 450 kr');
});
t('pair description shows kroner for a real thousandths price', () => {
  const seats = AB.expandSeats(AB.normalizeItems({ resaleItems: [liveItem({ mid: 1, row: '5', seat: '844' }), liveItem({ mid: 2, row: '5', seat: '845' })] }));
  assert.strictEqual(AB.describePairs(AB.choosePairs(seats).pairs), '124 row 5 seats 844-845 Category 3 690 kr');
});
t('seat description caps the list', () => {
  const d = AB.describeSeats(S(1, 3, 5, 7, 9, 11, 13, 15));
  assert.ok(d.endsWith('+2 more'), d);
});
t('match page link carries the performance id', () => assert.ok(AB.matchPage('10229739913107').indexOf('performanceId=10229739913107') > 0));

console.log('# page mode + intent (state machine across the queue navigation)');
t('list page is recognised', () => assert.strictEqual(AB.pageMode('/list/resaleProducts/', 'Mens Nations League'), 'list'));
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
  assert.strictEqual(AB.seatKey(AB.choosePairs(seats)), '11,22');
  assert.strictEqual(AB.seatKey(null), '');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

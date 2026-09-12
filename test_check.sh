#!/usr/bin/env bash
# Tests for check.sh.  Run:  bash test_check.sh
# check.sh is exercised with file hooks instead of HTTP (CATALOG_FILE,
# ITEMS_FILE_TEMPLATE, SHOP_FILE), NOW_HOUR/NOW_MINUTE instead of the clock,
# RETRY_SLEEP=0 and DRY_RUN=1 (prints "NOTIFY ..." lines instead of calling ntfy.sh).
set -u
cd "$(dirname "$0")"
F=test-fixtures
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0; out=''; rc=0
DK=10229739913106; PT=10229739913107
DK_URL="https://resale.fotball.no/selection/resale/item?performanceId=$DK&checkResaleAvailability=true"
PT_URL="https://resale.fotball.no/selection/resale/item?performanceId=$PT&checkResaleAvailability=true"
LIST_URL="https://resale.fotball.no/list/resaleProducts/?lang=en"
SHOP_URL="https://billett.fotball.no/selection/event/date?productId=10229739619905&lang=en"

run() {  # run <catalog fixture> <denmark items fixture> <portugal items fixture> <shop fixture> <hour> <minute>
  rm -f "$tmp"/items-*.json
  [ "$2" != MISSING ] && cp "$2" "$tmp/items-$DK.json"
  [ "$3" != MISSING ] && cp "$3" "$tmp/items-$PT.json"
  out=$(CATALOG_FILE="$1" ITEMS_FILE_TEMPLATE="$tmp/items-{id}.json" SHOP_FILE="$4" NOW_HOUR="$5" NOW_MINUTE="$6" \
        RECENT_FILE="${RECENT:-}" RETRY_SLEEP=0 DRY_RUN=1 NTFY_TOPIC=test-topic bash ./check.sh 2>&1)
  rc=$?
}
ok() { pass=$((pass+1)); echo "ok   - $1"; }
ko() { fail=$((fail+1)); echo "FAIL - $1"; echo "       $2"; printf '%s\n' "$out" | sed 's/^/       | /'; }
assert_rc0()          { [ "$rc" -eq 0 ] && ok "$1" || ko "$1" "exit code was $rc"; }
assert_contains()     { grep -qF -- "$2" <<<"$out" && ok "$1" || ko "$1" "missing: $2"; }
assert_not_contains() { grep -qF -- "$2" <<<"$out" && ko "$1" "unexpected: $2" || ok "$1"; }
assert_notify_count() { local got; got=$(grep -c '^NOTIFY ' <<<"$out"); [ "$got" -eq "$2" ] && ok "$1" || ko "$1" "expected $2 NOTIFY lines, got $got"; }

E=$F/catalog-empty.json; H=$F/catalog-hit.json; O=$F/catalog-other.json
IE=$F/items-empty.json; IH=$F/items-hit.json
SS=$F/shop-soldout.html; SD=$F/shop-onsale-denmark.html; WR=$F/waiting-room.html

echo "# nothing listed anywhere (the normal state)"
run $E $IE $IE $SS 14 30
assert_rc0            "quiet run exits 0"
assert_contains       "quiet run reports resale=EMPTY" "resale=EMPTY"
assert_contains       "quiet run reports the parsed quantity" "qty=0"
assert_contains       "quiet run reports per-match counts" "denmark=0 portugal=0"
assert_contains       "quiet run reports shop=SOLDOUT" "shop=SOLDOUT"
assert_notify_count   "quiet run mid-hour sends nothing" 0
run $E $IE $IE $SS 08 00
assert_notify_count   "quiet run at 08:00 UTC sends one heartbeat" 1
assert_contains       "heartbeat is low priority" "NOTIFY priority=low"
assert_contains       "heartbeat says still watching" "Still watching"
assert_contains       "heartbeat shows the parsed Denmark count" "Denmark 0"
assert_contains       "heartbeat shows the shop status" "sold out"
run $E $IE $IE $SS 08 03
assert_notify_count   "heartbeat also fires at 08:03 (late runner)" 1
run $E $IE $IE $SS 08 05
assert_notify_count   "no second heartbeat at 08:05" 0
run $E $IE $IE $SS 09 00
assert_notify_count   "no heartbeat at 09:00" 0

echo "# resale hit: Nations League quantity > 0, Denmark items listed"
run $H $IH $IE $SS 14 30
assert_rc0            "hit exits 0"
assert_contains       "hit reports resale=HIT" "resale=HIT"
assert_contains       "hit reports quantity and per-match counts" "qty=3 denmark=2 portugal=0"
assert_notify_count   "hit sends exactly one notification" 1
assert_contains       "hit notification is urgent" "NOTIFY priority=urgent"
assert_contains       "hit notification title says tickets listed" "TICKETS LISTED"
assert_contains       "hit notification names Denmark with the count" "Denmark: 2"
assert_contains       "hit notification links to the Denmark match page" "click=$DK_URL"
run $H $IH $IE $SS 14 35
assert_notify_count   "hit notifies again on the next run (no throttle)" 1
run $H $IH $IE $SS 08 00
assert_notify_count   "hit at 08:00 sends the urgent alert only, no heartbeat" 1
assert_contains       "  ...and it is the urgent one" "NOTIFY priority=urgent"

echo "# resale hit: quantity > 0 but neither September match has items (maybe 14 Nov)"
run $H $IE $IE $SS 14 30
assert_contains       "unknown-match hit still reports resale=HIT" "resale=HIT"
assert_notify_count   "unknown-match hit still alerts" 1
assert_contains       "unknown-match alert is urgent" "NOTIFY priority=urgent"
assert_contains       "unknown-match alert mentions the 14 Nov possibility" "14 Nov"
assert_contains       "unknown-match alert links to the resale list" "click=$LIST_URL"

echo "# resale hit: catalog says 0 but the Portugal item list is not empty (defence in depth)"
run $E $IE $IH $SS 14 30
assert_contains       "portugal-only hit reports resale=HIT" "resale=HIT"
assert_contains       "portugal-only hit reports counts" "denmark=0 portugal=2"
assert_notify_count   "portugal-only hit alerts" 1
assert_contains       "portugal-only alert is urgent" "NOTIFY priority=urgent"
assert_contains       "portugal-only alert names Portugal" "Portugal: 2"
assert_contains       "portugal-only alert links to the Portugal match page" "click=$PT_URL"

echo "# some other product has resale tickets"
run $O $IE $IE $SS 14 30
assert_contains       "other product reports resale=SOMETHING" "resale=SOMETHING"
assert_notify_count   "other product mid-hour sends nothing" 0
run $O $IE $IE $SS 14 02
assert_notify_count   "other product at top of hour sends one notification" 1
assert_contains       "other product notification is default priority" "NOTIFY priority=default"
assert_contains       "other product notification names the product" "Cupfinale"

echo "# waiting room instead of the catalog"
run $WR $IE $IE $SS 14 30
assert_rc0            "waiting room exits 0"
assert_contains       "waiting room reports resale=QUEUE" "resale=QUEUE"
assert_notify_count   "waiting room mid-hour sends nothing" 0
run $WR $IE $IE $SS 14 00
assert_notify_count   "waiting room at top of hour sends one notification" 1
assert_contains       "waiting room notification is default priority" "NOTIFY priority=default"
assert_contains       "waiting room notification says waiting room" "waiting room"

echo "# catalog fetch failure"
run "$tmp/does-not-exist.json" $IE $IE $SS 14 30
assert_rc0            "fetch failure exits 0 (no GitHub failure mails)"
assert_contains       "fetch failure reports resale=ERROR" "resale=ERROR"
assert_notify_count   "fetch failure mid-hour sends nothing" 0
run "$tmp/does-not-exist.json" $IE $IE $SS 14 00
assert_notify_count   "fetch failure at top of hour sends one notification" 1
assert_contains       "fetch failure notification says fetch failed" "fetch failed"

echo "# per-match item fetch failure with an otherwise quiet catalog"
run $E MISSING $IE $SS 14 30
assert_rc0            "item fetch failure exits 0"
assert_contains       "item fetch failure is visible in the log line" "denmark=ERR"
assert_notify_count   "item fetch failure mid-hour sends nothing" 0

echo "# main shop: Denmark no longer sold out"
run $E $IE $IE $SD 14 30
assert_contains       "shop on sale reports shop=ONSALE:Denmark" "shop=ONSALE:Denmark"
assert_notify_count   "shop on sale sends one notification" 1
assert_contains       "shop on sale alert is urgent" "NOTIFY priority=urgent"
assert_contains       "shop on sale alert title says on sale" "ON SALE"
assert_contains       "shop on sale alert names Denmark" "Denmark"
assert_contains       "shop on sale alert links to the shop performance list" "click=$SHOP_URL"

echo "# main shop: waiting room / fetch failure"
run $E $IE $IE $WR 14 30
assert_contains       "shop waiting room reports shop=QUEUE" "shop=QUEUE"
assert_notify_count   "shop waiting room mid-hour sends nothing" 0
run $E $IE $IE $WR 14 00
assert_notify_count   "shop waiting room at top of hour sends one notification" 1
run $E $IE $IE "$tmp/nope.html" 14 30
assert_contains       "shop fetch failure reports shop=ERROR" "shop=ERROR"
assert_notify_count   "shop fetch failure mid-hour sends nothing" 0

echo "# deduplication against messages already on the ntfy topic (1-minute cadence)"
recent() {  # recent <title>... -> writes an ntfy-style JSON-lines file, sets RECENT
  RECENT="$tmp/recent.jsonl"; : > "$RECENT"
  for t in "$@"; do printf '{"id":"x","time":%s,"event":"message","topic":"test-topic","title":"%s","message":"m"}
' "$(date +%s)" "$t" >> "$RECENT"; done
}
recent "NFF resale watcher"
run $E $IE $IE $SS 08 01
assert_notify_count   "heartbeat is skipped when the same title went out in the last 20 min" 0
assert_contains       "  ...and the skip is logged" "skipped duplicate"
recent "NFF resale: other tickets listed"
run $O $IE $IE $SS 14 01
assert_notify_count   "hourly other-product notice is skipped when already sent" 0
recent "NFF resale watcher"
run $WR $IE $IE $SS 14 02
assert_notify_count   "hourly waiting-room notice is skipped when already sent" 0
recent "TICKETS LISTED on NFF resale!"
run $H $IH $IE $SS 14 30
assert_notify_count   "urgent alerts are never deduplicated" 1
assert_contains       "  ...and stay urgent" "NOTIFY priority=urgent"
recent "TICKETS LISTED on NFF resale!"
run $E $IE $IE $SS 08 00
assert_notify_count   "a recent message with a different title does not suppress the heartbeat" 1
RECENT=''
run $E $IE $IE $SS 08 00
assert_notify_count   "with no recent messages the heartbeat is sent" 1

echo "# both channels at once"
run $H $IH $IE $SD 14 30
assert_notify_count   "resale hit + shop on sale sends two urgent notifications" 2
assert_not_contains   "  ...and nothing of lower priority" "priority=default"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

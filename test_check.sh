#!/usr/bin/env bash
# Tests for check.sh.  Run:  bash test_check.sh
# check.sh is exercised with HTML_FILE (instead of fetching), NOW_HOUR/NOW_MINUTE
# (instead of the clock) and DRY_RUN=1 (prints "NOTIFY ..." lines instead of
# calling ntfy.sh).
set -u
cd "$(dirname "$0")"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0; out=''; rc=0

cat > "$tmp/empty.html" <<'HTML'
<html><body>
<div id="notif_no_ticket_on_sales">There are currently no tickets being resold. Please visit us again in a few days.</div>
</body></html>
HTML
cat > "$tmp/denmark.html" <<'HTML'
<html><body><table>
<tr><td>Norge - Danmark</td><td>24.09.2026 20:45</td><td>Buy</td></tr>
</table></body></html>
HTML
cat > "$tmp/portugal_lower.html" <<'HTML'
<html><body><table>
<tr><td>norway v portugal</td><td>27.09.2026 20:45</td><td>Buy</td></tr>
</table></body></html>
HTML
cat > "$tmp/other.html" <<'HTML'
<html><body><table>
<tr><td>Norge - Sverige</td><td>10.10.2026 18:00</td><td>Buy</td></tr>
</table></body></html>
HTML

run() {  # run <html file> <hour> <minute>
  out=$(HTML_FILE="$1" NOW_HOUR="$2" NOW_MINUTE="$3" DRY_RUN=1 NTFY_TOPIC=test-topic bash ./check.sh 2>&1)
  rc=$?
}
ok() { pass=$((pass+1)); echo "ok   - $1"; }
ko() { fail=$((fail+1)); echo "FAIL - $1"; echo "       $2"; printf '%s\n' "$out" | sed 's/^/       | /'; }
assert_rc0()          { [ "$rc" -eq 0 ] && ok "$1" || ko "$1" "exit code was $rc"; }
assert_contains()     { grep -q -- "$2" <<<"$out" && ok "$1" || ko "$1" "missing: $2"; }
assert_not_contains() { grep -q -- "$2" <<<"$out" && ko "$1" "unexpected: $2" || ok "$1"; }
assert_notify_count() { local got; got=$(grep -c '^NOTIFY ' <<<"$out"); [ "$got" -eq "$2" ] && ok "$1" || ko "$1" "expected $2 NOTIFY lines, got $got"; }

echo "# empty page"
run "$tmp/empty.html" 14 30
assert_rc0            "empty page exits 0"
assert_contains       "empty page reports EMPTY" "state=EMPTY"
assert_notify_count   "empty page mid-hour sends nothing" 0
run "$tmp/empty.html" 08 00
assert_notify_count   "empty page at 08:00 UTC sends one heartbeat" 1
assert_contains       "heartbeat is low priority" "NOTIFY priority=low"
run "$tmp/empty.html" 09 00
assert_notify_count   "empty page at 09:00 UTC sends no heartbeat" 0
run "$tmp/empty.html" 08 03
assert_notify_count   "empty page at 08:03 UTC (runner started late) still sends the heartbeat" 1
run "$tmp/empty.html" 08 05
assert_notify_count   "empty page at 08:05 UTC (next 5-min slot) sends no second heartbeat" 0

echo "# Denmark / Portugal listing"
run "$tmp/denmark.html" 14 30
assert_rc0            "hit exits 0"
assert_contains       "hit reports HIT state" "state=HIT"
assert_notify_count   "hit sends exactly one notification" 1
assert_contains       "hit notification is urgent" "NOTIFY priority=urgent"
assert_contains       "hit notification names the keyword" "Danmark"
assert_contains       "hit notification links to the resale page" "click=https://resale.fotball.no/list/resaleProducts/?lang=en"
run "$tmp/denmark.html" 14 35
assert_notify_count   "hit notifies again on the next run (no throttle)" 1
run "$tmp/portugal_lower.html" 14 30
assert_contains       "keyword match is case-insensitive" "state=HIT"

echo "# listing for some other match"
run "$tmp/other.html" 14 30
assert_rc0            "other exits 0"
assert_contains       "other reports SOMETHING state" "state=SOMETHING"
assert_notify_count   "other mid-hour sends nothing" 0
run "$tmp/other.html" 14 00
assert_notify_count   "other at top of hour sends one notification" 1
assert_contains       "other notification is default priority" "NOTIFY priority=default"
run "$tmp/other.html" 14 04
assert_notify_count   "other at 14:04 (runner started late) still sends one notification" 1

echo "# fetch failure"
run "$tmp/does-not-exist.html" 14 30
assert_rc0            "fetch failure exits 0 (no GitHub failure mails)"
assert_contains       "fetch failure reports ERROR state" "state=ERROR"
assert_notify_count   "fetch failure mid-hour sends nothing" 0
run "$tmp/does-not-exist.html" 14 00
assert_notify_count   "fetch failure at top of hour sends one notification" 1
assert_contains       "fetch failure notification says fetch failed" "fetch failed"
run "$tmp/does-not-exist.html" 14 02
assert_notify_count   "fetch failure at 14:02 (runner started late) still sends one notification" 1

echo "# URL override (for end-to-end tests against a fixture page)"
out=$(HTML_FILE="$tmp/denmark.html" NOW_HOUR=14 NOW_MINUTE=30 DRY_RUN=1 NTFY_TOPIC=test-topic RESALE_URL="https://example.test/fixture.html" bash ./check.sh 2>&1); rc=$?
assert_contains     "RESALE_URL override is used for the click link" "click=https://example.test/fixture.html"
run "$tmp/denmark.html" 14 30
assert_contains     "without override the click link is the real resale page" "click=https://resale.fotball.no/list/resaleProducts/?lang=en"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

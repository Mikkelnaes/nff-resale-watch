#!/usr/bin/env bash
# Watches NFF's official resale site and the main ticket shop for tickets to
# Norway-Denmark (24 Sep 2026) and Norway-Portugal (27 Sep 2026) and pushes a
# phone notification via ntfy.sh.
#
# What is checked on every run (all server-side data, no JavaScript needed):
#   1. resale catalog JSON   /list/resale/resaleProductCatalog.json
#        -> availableQuantity of the "Mens Nations League" product (all its matches)
#   2. per-match resale JSON /selection/resale/resaleItems.json?performanceId=<id>
#        -> number of tickets listed for Denmark and for Portugal specifically
#   3. main shop HTML        billett.fotball.no/selection/event/date?productId=...
#        -> per-match "sold_out" status class (catches a release of returned tickets)
# The resale HTML list page is NOT used: its "no tickets" text is always present
# in the HTML (JavaScript unhides it), and its product name never contains an
# opponent, so grepping it can never detect a listing.
#
# The sites sit behind a SecuTix virtual waiting room that sometimes redirects
# requests to a queue page; fetches follow redirects with a cookie jar, retry,
# and report QUEUE if still blocked.
#
# Env:
#   NTFY_TOPIC            ntfy.sh topic to publish to (required unless DRY_RUN=1)
#   CATALOG_URL, ITEMS_URL_TEMPLATE ({id} placeholder), SHOP_URL
#                         override the three URLs (end-to-end tests against fixtures)
#   CATALOG_FILE, ITEMS_FILE_TEMPLATE ({id}), SHOP_FILE
#                         test hooks: read these files instead of fetching
#   NOW_HOUR / NOW_MINUTE test hook: override the UTC clock
#   PASSES / PASS_GAP     reads per run and seconds between them (default 2 / 30): the job
#                         is started every minute, so the sites are read every ~30 s
#   RETRY_SLEEP           seconds between fetch attempts (default 5)
#   DEDUPE_WINDOW         non-urgent notices are skipped if the same title was already
#                         published to the topic within this window (default 20m); the
#                         workflow runs every minute, so several runs land in the
#                         "top of hour" window
#   RECENT_FILE           test hook: ntfy JSON-lines file used instead of asking ntfy.sh
#                         ({pass} in any test-hook path is replaced by the pass number)
#   DRY_RUN=1             print "NOTIFY ..." lines instead of calling ntfy.sh
#
# Always exits 0 so a flaky fetch does not trigger GitHub's failure e-mails;
# persistent problems are reported hourly via ntfy instead.
set -u

# --- configuration -------------------------------------------------------------
CATALOG_URL=${CATALOG_URL:-'https://resale.fotball.no/list/resale/resaleProductCatalog.json?lang=en'}
ITEMS_URL_TEMPLATE=${ITEMS_URL_TEMPLATE:-'https://resale.fotball.no/selection/resale/resaleItems.json?performanceId={id}&lang=en'}
SHOP_URL=${SHOP_URL:-'https://billett.fotball.no/selection/event/date?productId=10229739619905&lang=en'}
PRODUCT_ID=${PRODUCT_ID:-10229739619905}          # "Mens Nations League" (24 Sep, 27 Sep, 14 Nov)
PRODUCT_NAME_RE=${PRODUCT_NAME_RE:-'Nations League'} # fallback if the id ever changes
MATCHES=${MATCHES:-'10229739913106:Denmark 10229739913107:Portugal'}
LIST_PAGE='https://resale.fotball.no/list/resaleProducts/?lang=en'
SHOP_PAGE='https://billett.fotball.no/selection/event/date?productId=10229739619905&lang=en'
match_page() { echo "https://resale.fotball.no/selection/resale/item?performanceId=$1&checkResaleAvailability=true"; }
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) nff-resale-watch'
ATTEMPTS=${ATTEMPTS:-2}
RETRY_SLEEP=${RETRY_SLEEP:-5}
DEDUPE_WINDOW=${DEDUPE_WINDOW:-20m}
PASSES=${PASSES:-2}        # reads per run
PASS_GAP=${PASS_GAP:-30}   # seconds between the start of consecutive passes
MAX_RUN=${MAX_RUN:-50}     # skip remaining passes once the run is this old (the next run starts every minute)
NTFY_TOPIC=${NTFY_TOPIC:-}

hour=${NOW_HOUR:-$(date -u +%H)}
minute=${NOW_MINUTE:-$(date -u +%M)}
# "Top of hour" = minutes 00-04: runs are triggered on the :00 mark, but the runner
# may start up to a few minutes late. Only one 5-minute slot falls in this window.
top_of_hour=false; case "$minute" in 0[0-4]|[0-4]) top_of_hour=true ;; esac

cd "$(dirname "$0")"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
JAR="$work/cookies.txt"
PY=''
for c in python3 python; do "$c" -c 'import sys' >/dev/null 2>&1 && { PY=$c; break; }; done

notify() {  # notify <priority> <title> <click url> <message>
  local priority=$1 title=$2 click=$3 message=$4
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "NOTIFY priority=$priority title=$title click=$click msg=$message"
    return
  fi
  if [ -z "$NTFY_TOPIC" ]; then echo "NTFY_TOPIC not set; cannot notify" >&2; return; fi
  curl -fsS -o /dev/null -X POST "https://ntfy.sh/$NTFY_TOPIC" \
    -H "Title: $title" -H "Priority: $priority" -H "Tags: soccer,ticket" \
    -H "Click: $click" -d "$message" \
    && echo "notified ($priority): $message" \
    || echo "ntfy publish failed" >&2
}

# Non-urgent notices go out at most once per DEDUPE_WINDOW: the topic's own message
# cache (ntfy.sh keeps 12 h) tells us what was already published. Fails open.
recent_loaded=false; recent_titles=''
load_recent() {
  $recent_loaded && return; recent_loaded=true
  local f="$work/recent.jsonl"
  if [ -n "${RECENT_FILE:-}" ]; then
    cp "$RECENT_FILE" "$f" 2>/dev/null || : > "$f"
  elif [ "${DRY_RUN:-0}" = "1" ] || [ -z "$NTFY_TOPIC" ]; then
    : > "$f"
  else
    curl -fsS --max-time 15 "https://ntfy.sh/$NTFY_TOPIC/json?poll=1&since=$DEDUPE_WINDOW" -o "$f" 2>/dev/null || : > "$f"
  fi
  recent_titles=$(parse titles "$f" || true)
}
notify_once() {  # notify_once <priority> <title> <click url> <message>; skipped if <title> was sent within DEDUPE_WINDOW
  load_recent
  if grep -qxF -- "$2" <<<"$recent_titles"; then
    echo "skipped duplicate: '$2' already sent within $DEDUPE_WINDOW"
    return
  fi
  notify "$@"
}

is_waiting_room() { grep -q '<title>Waiting Room</title>' "$1" 2>/dev/null; }

# fetch <url> <outfile> [<test hook file>] -> FETCH=OK|QUEUE|ERROR, FETCH_ERR=<detail>
fetch() {
  local url=$1 out=$2 hook=${3:-} attempt res code final
  FETCH=ERROR; FETCH_ERR=''
  if [ -n "$hook" ]; then
    if cp "$hook" "$out" 2>/dev/null; then
      if is_waiting_room "$out"; then FETCH=QUEUE; FETCH_ERR='waiting room'; else FETCH=OK; fi
    else
      FETCH_ERR="cannot read $hook"
    fi
    return
  fi
  for attempt in $(seq 1 "$ATTEMPTS"); do
    res=$(curl -sS -L -A "$UA" --max-time 20 -c "$JAR" -b "$JAR" -o "$out" \
          -w '%{http_code} %{url_effective}' "$url" 2>"$work/curl.err") || res="000 -"
    code=${res%% *}; final=${res#* }
    if [[ "$final" == *pkpcontroller* ]] || is_waiting_room "$out"; then
      FETCH=QUEUE; FETCH_ERR="waiting room after $attempt attempt(s)"
    elif [ "$code" = "200" ]; then
      FETCH=OK; FETCH_ERR=''; return
    else
      FETCH=ERROR; FETCH_ERR="HTTP $code $(head -c 80 "$work/curl.err" 2>/dev/null | tr -d '\n')"
      [ "$code" = "000" ] || return           # a real HTTP error: no point retrying
    fi
    [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$RETRY_SLEEP"
  done
}

parse() {  # run parse.py; strip any CR a Windows python may emit; keep its exit status
  local out rc
  out=$("$PY" parse.py "$@" 2>"$work/parse.err"); rc=$?
  printf '%s' "${out//$'\r'/}"
  return $rc
}
parse_err() { head -c 120 "$work/parse.err" | tr -d '\n'; }
hook() { printf '%s' "${1//\{pass\}/$2}"; }   # hook <test hook path> <pass>

if [ -z "$PY" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) resale=ERROR qty=- shop=ERROR (python not found)"
  $top_of_hour && notify default 'NFF resale watcher' "$LIST_PAGE" 'fetch failed: python not found on the runner (check the workflow)'
  exit 0
fi

run_pass() {  # run_pass <n>: fetch, classify, notify
  local pass=$1
# --- 1. resale catalog ---------------------------------------------------------
resale_state=''; resale_err=''; qty='-'; others=''
fetch "$CATALOG_URL" "$work/catalog.json" "$(hook "${CATALOG_FILE:-}" "$pass")"
case $FETCH in
  OK)
    if parsed=$(parse catalog "$work/catalog.json" "$PRODUCT_ID" "$PRODUCT_NAME_RE"); then
      qty=$(sed -n 's/^qty=//p' <<<"$parsed"); others=$(sed -n 's/^others=//p' <<<"$parsed")
      [ "$qty" = "missing" ] && { resale_state=ERROR; resale_err="Nations League product not found in the resale catalog"; }
    else
      resale_state=ERROR; resale_err="catalog parse: $(parse_err)"
    fi ;;
  QUEUE) resale_state=QUEUE; resale_err="catalog: $FETCH_ERR" ;;
  *)     resale_state=ERROR; resale_err="catalog: $FETCH_ERR" ;;
esac

# --- 2. per-match resale items ---------------------------------------------------
counts_log=''; hit_lines=''; hit_click=''; items_err=''; heartbeat_resale=''
for m in $MATCHES; do
  id=${m%%:*}; name=${m#*:}
  url=${ITEMS_URL_TEMPLATE//\{id\}/$id}
  hookfile=''; [ -n "${ITEMS_FILE_TEMPLATE:-}" ] && hookfile=$(hook "${ITEMS_FILE_TEMPLATE//\{id\}/$id}" "$pass")
  fetch "$url" "$work/items-$id.json" "$hookfile"
  count=ERR
  if [ "$FETCH" = OK ]; then
    if c=$(parse items "$work/items-$id.json"); then count=${c#count=}; else items_err="$name items parse: $(parse_err)"; fi
  elif [ "$FETCH" = QUEUE ]; then count=QUEUE
  else items_err="$name items: $FETCH_ERR"
  fi
  counts_log+="${name,,}=$count "
  heartbeat_resale+="$name $count, "
  if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -gt 0 ]; then
    hit_lines+="$name: $count tickets. "
    [ -z "$hit_click" ] && hit_click=$(match_page "$id")
  else
    hit_lines+="$name: ${count/ERR/?}. "
  fi
done
counts_log=${counts_log% }; heartbeat_resale=${heartbeat_resale%, }

# --- classify resale -----------------------------------------------------------
if [ -n "$hit_click" ]; then
  resale_state=HIT
  resale_msg="${hit_lines}Nations League total ${qty/-/?}. Open resale.fotball.no now."
elif [ -z "$resale_state" ]; then
  if [[ "$qty" =~ ^[0-9]+$ ]] && [ "$qty" -gt 0 ]; then
    resale_state=HIT; hit_click=$LIST_PAGE
    resale_msg="Nations League resale shows $qty ticket(s) but none for Denmark or Portugal. Could be the 14 Nov match. Check resale.fotball.no."
  elif [ -n "$others" ]; then
    resale_state=SOMETHING
  else
    resale_state=EMPTY
  fi
fi

# --- 3. main shop --------------------------------------------------------------
shop_state=''; shop_err=''; onsale=''; heartbeat_shop=''
fetch "$SHOP_URL" "$work/shop.html" "$(hook "${SHOP_FILE:-}" "$pass")"
case $FETCH in
  OK)
    # shellcheck disable=SC2086
    if parsed=$(parse shop "$work/shop.html" $MATCHES); then
      while IFS='=' read -r name st; do
        [ -z "$name" ] && continue
        case $st in
          soldout)  heartbeat_shop+="$name sold out, " ;;
          onsale*)  heartbeat_shop+="$name ON SALE, "; onsale+="$name," ;;
          *)        heartbeat_shop+="$name unknown, "; shop_err="shop parse: no status found for $name" ;;
        esac
      done <<<"$parsed"
      heartbeat_shop=${heartbeat_shop%, }; onsale=${onsale%,}
      if [ -n "$onsale" ]; then shop_state="ONSALE:$onsale"
      elif [ -n "$shop_err" ]; then shop_state=ERROR
      else shop_state=SOLDOUT; fi
    else
      shop_state=ERROR; shop_err="shop parse: $(parse_err)"
    fi ;;
  QUEUE) shop_state=QUEUE; shop_err="shop: $FETCH_ERR" ;;
  *)     shop_state=ERROR; shop_err="shop: $FETCH_ERR" ;;
esac

# --- report ----------------------------------------------------------------------
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$stamp pass=$pass/$PASSES resale=$resale_state qty=$qty $counts_log shop=$shop_state"
[ -n "$resale_err" ] && echo "  $resale_err"
[ -n "$items_err" ] && echo "  $items_err"
[ -n "$shop_err" ] && echo "  $shop_err"

urgent=false
if [ "$resale_state" = HIT ]; then
  notify urgent 'TICKETS LISTED on NFF resale!' "$hit_click" "$resale_msg"; urgent=true
fi
if [[ "$shop_state" == ONSALE:* ]]; then
  notify urgent 'TICKETS ON SALE at billett.fotball.no!' "$SHOP_PAGE" "${onsale//,/ and } no longer marked sold out on billett.fotball.no. Buy now."; urgent=true
fi

if ! $urgent && $top_of_hour && [ "$pass" = 1 ]; then   # hourly notices / heartbeat: first pass only
  sent=false
  if [ "$resale_state" = SOMETHING ]; then
    notify_once default 'NFF resale: other tickets listed' "$LIST_PAGE" "$others (not Nations League). Worth a look."; sent=true
  fi
  if [ "$resale_state" = QUEUE ] || [ "$shop_state" = QUEUE ] || [[ "$counts_log" == *QUEUE* ]]; then
    notify_once default 'NFF resale watcher' "$LIST_PAGE" "waiting room blocked the check this hour ($resale_err $shop_err). Retrying every minute."; sent=true
  fi
  errs="$resale_err $items_err $shop_err"
  if [ "$resale_state" = ERROR ] || [ "$shop_state" = ERROR ] || [ -n "$items_err" ]; then
    notify_once default 'NFF resale watcher' "$LIST_PAGE" "fetch failed: ${errs## } (still failing at next full hour = check the workflow)"; sent=true
  fi
  if ! $sent && [ "$hour" = "08" ]; then
    notify_once low 'NFF resale watcher' "$LIST_PAGE" "Still watching. Resale: Nations League $qty tickets ($heartbeat_resale). Shop: $heartbeat_shop."
  fi
fi
}

# --- run: PASSES reads, PASS_GAP seconds apart ---------------------------------
start=$(date +%s)
for ((pass=1; pass<=PASSES; pass++)); do
  if [ "$pass" -gt 1 ]; then
    now=$(date +%s); wait=$(( start + (pass-1)*PASS_GAP - now ))
    [ "$wait" -gt 0 ] && sleep "$wait"
    now=$(date +%s)
    if [ $((now - start)) -gt "$MAX_RUN" ]; then echo "pass $pass/$PASSES skipped: run already $((now - start)) s old"; break; fi
  fi
  run_pass "$pass"
done
exit 0

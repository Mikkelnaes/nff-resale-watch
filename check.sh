#!/usr/bin/env bash
# Polls NFF's official resale page and pushes a phone notification via ntfy.sh
# when tickets for Norway-Denmark or Norway-Portugal are listed.
#
# Env:
#   NTFY_TOPIC   ntfy.sh topic to publish to (required unless DRY_RUN=1)
#   KEYWORDS     regex of match names to alert on (default: Danmark|Denmark|Portugal)
#   HTML_FILE    test hook: read the page from this file instead of fetching it
#   NOW_HOUR / NOW_MINUTE   test hook: override the UTC clock
#   DRY_RUN=1    print "NOTIFY ..." lines instead of calling ntfy.sh
#
# Always exits 0 so a flaky fetch does not trigger GitHub's failure e-mails;
# persistent fetch failures are reported hourly via ntfy instead.
set -u

URL='https://resale.fotball.no/list/resaleProducts/?lang=en'
EMPTY_MARKER='no tickets being resold'
KEYWORDS=${KEYWORDS:-'Danmark|Denmark|Portugal'}
NTFY_TOPIC=${NTFY_TOPIC:-}
hour=${NOW_HOUR:-$(date -u +%H)}
minute=${NOW_MINUTE:-$(date -u +%M)}
top_of_hour=false; [ "$minute" = "00" ] && top_of_hour=true

notify() {  # notify <priority> <title> <message>
  local priority=$1 title=$2 message=$3
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "NOTIFY priority=$priority title=$title click=$URL msg=$message"
    return
  fi
  if [ -z "$NTFY_TOPIC" ]; then echo "NTFY_TOPIC not set; cannot notify" >&2; return; fi
  curl -fsS -o /dev/null -X POST "https://ntfy.sh/$NTFY_TOPIC" \
    -H "Title: $title" -H "Priority: $priority" -H "Tags: soccer,ticket" \
    -H "Click: $URL" -d "$message" \
    && echo "notified ($priority): $message" \
    || echo "ntfy publish failed" >&2
}

# --- fetch -------------------------------------------------------------------
html=''; fetch_error=''
if [ -n "${HTML_FILE:-}" ]; then
  html=$(cat "$HTML_FILE" 2>/dev/null) || fetch_error="cannot read $HTML_FILE"
else
  html=$(curl -sS -A 'Mozilla/5.0' --max-time 30 -w '\n%{http_code}' "$URL" 2>&1)
  code=${html##*$'\n'}; html=${html%$'\n'*}
  [ "$code" = "200" ] || fetch_error="HTTP $code"
fi
[ -z "$fetch_error" ] && [ -z "$html" ] && fetch_error="empty response"

stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- classify ----------------------------------------------------------------
if [ -n "$fetch_error" ]; then
  echo "$stamp state=ERROR $fetch_error"
  $top_of_hour && notify default 'NFF resale watcher' "fetch failed: $fetch_error (still failing at next full hour = check the workflow)"
elif grep -qi -- "$EMPTY_MARKER" <<<"$html"; then
  echo "$stamp state=EMPTY"
  if [ "$hour" = "08" ] && $top_of_hour; then
    notify low 'NFF resale watcher' 'Still watching. Nothing listed on resale.fotball.no.'
  fi
else
  hits=$(grep -oiE -- "$KEYWORDS" <<<"$html" | sort -fu | paste -sd, -)
  if [ -n "$hits" ]; then
    echo "$stamp state=HIT $hits"
    notify urgent 'TICKETS LISTED on NFF resale!' "Listings matching: $hits. Open resale.fotball.no now."
  else
    echo "$stamp state=SOMETHING"
    $top_of_hour && notify default 'NFF resale: page not empty' 'Something is listed (other match?). Worth a look.'
  fi
fi
exit 0

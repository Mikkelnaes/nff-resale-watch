# Auto-basket for NFF resale listings (design, 15 Sep 2026)

Approved in chat on 15 Sep 2026.

## Problem

The cloud watcher detects a listing within 30 s, but the listings seen on 12 and
14 Sep were gone again after 60-90 s. The remaining time is spent by a person
tapping the push, opening the site and adding the tickets to the basket; someone
else is faster. A basket is bound to the browser session, not the account (tested
by the user on 15 Sep: a basket made on the laptop was not visible after logging
in on the phone), so a reservation made by a cloud bot could never be paid for.
The reservation therefore has to be made inside the user's own browser session.

## Components

### 1. Cloud watcher (`check.sh`, `parse.py`, workflow) -- unchanged trigger, richer output

- Keeps polling anonymously every ~30 s from GitHub Actions and pushing the
  urgent "TICKETS LISTED on NFF resale!" alert. The alert is also the trigger
  for the userscript (below), delivered over the ntfy stream.
- The alert message now lists the tickets (section, row, seat, category, price)
  as far as the resale JSON exposes them, so the phone shows what is on offer.
- On a hit, after the alert has been sent, the run saves evidence: the raw
  per-match items JSON and the match page HTML (which only exists while a
  listing is live) into `evidence/`, uploaded as a workflow artifact. The first
  real capture confirms the field names the userscript relies on and whether the
  page's `withCaptcha` flag is set.

### 2. Userscript `autobasket.user.js` (Tampermonkey, Chrome on the laptop)

- Runs on `https://resale.fotball.no/*` in a tab where the user is logged in.
  Does not poll the listing data. It subscribes to the ntfy topic's SSE stream
  and acts only when the cloud watcher's alert arrives.
- On an alert it fetches the per-match items JSON for Denmark and Portugal once
  (the same request the match page makes), selects seats by the rules below,
  and sends the same add-to-basket request the site's own button sends
  (`POST /ajax/selection/resale/item/submit`, JSON body
  `{performanceId, resaleItemData:[{audienceSubCategoryId, seatCategoryId,
  quantity, unitAmount, movementIds}]}`).
- Success: opens the basket in the tab, sounds an alarm, pushes
  "RESERVED, pay now" to the phone via ntfy, and stops acting for 20 minutes.
- Any refusal or missing data: sounds the alarm, pushes the reason, and
  navigates to the match page so the user is one click away. No captcha or
  waiting-room handling beyond reporting it.
- Optional session keepalive: one light request to the shop every 10 minutes so
  the login does not time out. Not listing polling.
- Small on-page overlay shows: armed/dry-run, ntfy connection state, last event,
  last action. A button arms the audio (browser autoplay policy) and tests the
  alarm.

### Seat selection rules (user's requirements)

- Take 4 tickets if possible, else 2, never 1 or 3.
- 2 = one adjacent pair: same section and row, seat numbers differing by 1.
- 4 = two adjacent pairs (may be in different places) or four in a row.
- If seat numbers are not available for a listing, do not reserve; alarm and
  open the match page instead.

### Configuration

- ntfy topic stored in the browser (`localStorage`), asked for on first run; the
  public repo carries no secret.
- Matches: `10229739913106` Denmark, `10229739913107` Portugal.

## Constraints accepted by the user

- NFF's terms forbid automated purchasing and allow cancellation; the user
  carries that risk. Payment stays manual (3-D Secure).
- Laptop must be on, awake, with the tab open in its own window.

## Testing

- `test_check.sh`: evidence files written on a hit, not on a quiet run; alert
  message carries seat details; alert is sent before evidence is fetched.
- `test_autobasket.js` (node): alert parsing, item normalisation across
  candidate field names, pair selection (0/1/2/3/4/5+ seats, mixed rows,
  odd/even gaps), payload construction, error-status mapping.

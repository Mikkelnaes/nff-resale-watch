# nff-resale-watch

Watches for tickets to Norway-Denmark (24 Sep 2026) and Norway-Portugal
(27 Sep 2026, both Ullevaal, UEFA Nations League) and pushes a notification to
your phone via [ntfy.sh](https://ntfy.sh). Runs on GitHub Actions every minute,
started by an external cron (see below), and reads the sites twice per run, 30 s
apart, so a listing is noticed within about 30 s. On 12 Sep 2026 it caught real
listings of 4 and then 1 Denmark tickets that were gone again within 5 minutes and
45 seconds respectively, hence the cadence.

## What is checked

`check.sh` reads three server-side sources on every run. No browser or JavaScript
is involved, and each one was verified against the live sites on 5 Sep 2026.

1. **Resale catalog JSON** `resale.fotball.no/list/resale/resaleProductCatalog.json`
   The product "Mens Nations League" covers the 24 Sep, 27 Sep and 14 Nov matches.
   Its `availableQuantity` is the number the site itself displays as "N tickets".
2. **Per-match resale JSON** `resale.fotball.no/selection/resale/resaleItems.json?performanceId=<id>`
   `10229739913106` = Denmark, `10229739913107` = Portugal. The `resaleItems` list
   holds the tickets on offer for that match. Checked every run, so a listing is
   caught even if the catalog number were wrong.
3. **Main shop HTML** `billett.fotball.no/selection/event/date?productId=10229739619905`
   Each performance carries a server-rendered `sold_out` status class. If NFF
   releases returned tickets on the primary shop, that class disappears.

Why not the resale HTML list page: its "There are currently no tickets being resold"
text is present in the HTML on every load with a `hidden` class (JavaScript unhides
it when the JSON comes back empty), and the product name never contains an opponent.
Grepping that page can never detect a listing. The first version of this watcher did
exactly that and would have stayed silent.

## Notifications

| Situation | Priority | When |
|---|---|---|
| Denmark or Portugal items listed, or Nations League quantity > 0 | urgent, links to the match page | every pass (about every 30 s) until you stop the job |
| A September match no longer `sold_out` on billett.fotball.no | urgent, links to the shop | every pass |
| Some other product has resale tickets | default | once an hour |
| Waiting room blocked a fetch, or a fetch/parse failed | default | once an hour (after 3 attempts inside the run) |
| Everything quiet | low "Still watching" heartbeat with the parsed numbers | daily 08:00 UTC |

"Once an hour" means the runs that land in minutes :00-:04 UTC (first pass only).
Because the job runs every minute, several runs fall in that window; before sending a non-urgent notice
the script reads the topic's own recent messages (`ntfy.sh/<topic>/json?since=20m`)
and skips the notice if one with the same title already went out. Urgent alerts are
never deduplicated: they repeat every minute while tickets are listed.

Both sites sit behind a SecuTix virtual waiting room that sometimes redirects a
request to a queue page. Fetches follow redirects with a cookie jar, retry up to
three times, and report `QUEUE` if still blocked, so it is distinguishable from a
real error in the run log:

    2026-09-05T20:20:03Z resale=EMPTY qty=0 denmark=0 portugal=0 shop=SOLDOUT

On a hit the alert lists what is on offer (section, row, seat, category, price, as
far as the resale JSON exposes them), and after the alert has gone out the run saves
the raw items JSON, the catalog and the per-match page HTML (which only exists while
a listing is live) to `evidence/`, uploaded as the workflow artifact
`evidence-<run id>` (14 days). The first real capture is what the userscript below
is verified against.

## Auto-basket userscript (reserves in your own browser)

The basket on resale.fotball.no belongs to the browser session, not to the account
(a basket made on the laptop is not visible after logging in on the phone), so the
reservation has to happen in the browser you will pay from. `autobasket.user.js`
does that. It does **not** poll the shop: it listens to the ntfy topic and acts when
the cloud watcher's "TICKETS LISTED on NFF resale!" alert arrives.

What it does on an alert, in the logged-in tab:

1. reads the per-match items JSON for Denmark and Portugal once (the same request
   the match page makes);
2. picks seats: 4 if two adjacent pairs exist (four in a row preferred), else 2 if
   one adjacent pair exists, never 1 or 3. Adjacent = same section, same row, seat
   numbers 1 apart. Tickets without seat numbers are never taken;
3. sends the shop's own add-to-basket request (`POST /ajax/selection/resale/item/submit`);
4. on success: a short quiet beep (2 s, `ALARM_SECONDS` / `ALARM_GAIN` in the script),
   the tab title flashes for 10 s, phone push "Auto-basket: RESERVED ... pay NOW", opens
   the basket. You pay by hand within the hold (about 15 minutes);
5. on anything else (waiting room, captcha, tickets gone, request format not
   recognised): alarm, phone push with the reason, opens the match page so you are
   one click away. It then pauses 3 minutes so it does not reload the page under you.

Install (Chrome on the laptop):

1. Install the Tampermonkey extension from the Chrome Web Store.
2. Tampermonkey dashboard -> `+` (new script) -> replace the template with the
   contents of `autobasket.user.js` -> Ctrl+S.
3. Open <https://resale.fotball.no/list/resaleProducts/?lang=en> and log in. A black
   box appears bottom-right. It asks for the ntfy topic (the same value as the
   `NTFY_TOPIC` secret); it is stored in the browser only.
4. Click **Arm audio / test alarm** once (browsers only allow sound after a click);
   allow desktop notifications if asked. The box must say `ARMED`, `ntfy: connected`,
   `this tab: active`, `login: yes`.
5. Leave the laptop on and awake (disable sleep), the tab open in its own window
   (not minimised). Keep one such tab; a second tab shows `standby`.

Dry run: **Switch to dry run** makes it push "would reserve ..." and open the match
page instead of reserving. **Reset** clears the cooldown after a reservation or the
pause after a failure. A keepalive request every 10 minutes keeps the login alive
(turn off with **Keepalive off**).

Assumptions and limits: seat numbers are taken as consecutive along a row (if
Ullevaal numbers odd/even from the aisle, set `ADJACENT_STEP` to 2); the field names
in the resale JSON are matched against several candidates until the first live
capture confirms them, and if the request cannot be built completely the script
opens the match page instead of sending a guess. The shop sits behind DataDome, AWS
WAF and a SecuTix waiting room; the script uses your real browser session and stops
with an alarm if any of them intervenes. Nothing bypasses a captcha. NFF's terms
forbid automated purchasing and allow cancelling such tickets; that risk is yours.

## Setup

1. Install the ntfy app (Android/iOS) and subscribe to your topic name.
2. Store the topic as a repository secret: `gh secret set NTFY_TOPIC`.
3. Test: `gh workflow run watch-resale` then watch the phone / `gh run list`.
4. Set up the external trigger (next section).

## External trigger (cron-job.org)

GitHub's `schedule` trigger fired only sporadically for this repo, so a free
[cron-job.org](https://cron-job.org) job POSTs to the GitHub API every minute
and starts the workflow. (GitHub occasionally cancels a queued duplicate when its
own schedule collides with a dispatch; that shows as a "cancelled" run and is harmless.)

1. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: **Only select repositories** -> `nff-resale-watch`.
   - Repository permissions: **Actions: Read and write** (a token with no
     repository permissions gets HTTP 403 from the dispatch endpoint).
   - Expiration: 28 Sep 2026 (the day after the last match).
2. Create a cronjob at <https://console.cron-job.org>:
   - URL: `https://api.github.com/repos/Mikkelnaes/nff-resale-watch/actions/workflows/resale-watch.yml/dispatches`
   - Schedule: every minute ("* * * * *"). The runs landing in minutes :00-:04
     carry the hourly notices and the 08:00 UTC heartbeat.
   - Advanced -> Request method: `POST`
   - Advanced -> Headers:
     - `Accept: application/vnd.github+json`
     - `Authorization: Bearer <the token from step 1>`
     - `X-GitHub-Api-Version: 2022-11-28`
     - `Content-Type: application/json`
   - Advanced -> Request body: `{"ref":"main"}`
   - Notifications: e-mail on failure. A successful call returns HTTP 204.
3. Verify: `gh run list --repo Mikkelnaes/nff-resale-watch --limit 5` shows a
   new `workflow_dispatch` run every minute.

## End-to-end test (real phone alert from fixture data)

    gh workflow run watch-resale --repo Mikkelnaes/nff-resale-watch \
      -f catalog_url=https://raw.githubusercontent.com/Mikkelnaes/nff-resale-watch/main/test-fixtures/catalog-hit.json \
      -f items_url_template='https://raw.githubusercontent.com/Mikkelnaes/nff-resale-watch/main/test-fixtures/items-{id}.json' \
      -f shop_url=https://raw.githubusercontent.com/Mikkelnaes/nff-resale-watch/main/test-fixtures/shop-onsale-denmark.html

Expect two urgent pushes: "TICKETS LISTED on NFF resale!" (Denmark: 2 tickets) and
"TICKETS ON SALE at billett.fotball.no!".

## Tests

`bash test_check.sh` (needs `python3` or `python`; no other dependencies) and
`node test_autobasket.js` (the userscript's decision logic: alert parsing, item
normalisation, pair selection, request building).
Fixtures in `test-fixtures/` are real captures from 5 Sep 2026 (`*-empty.json`,
`shop-soldout.html`, `waiting-room.html`) plus synthetic non-empty variants
built on the field semantics used by the site's own JavaScript
(`item-page-hit.html` stands in for the per-match page, which is a 404 while
nothing is listed).

## Stop

Once you have tickets: disable (or delete) the cron-job.org job, run
`gh workflow disable watch-resale`, and delete the token at
<https://github.com/settings/personal-access-tokens>.

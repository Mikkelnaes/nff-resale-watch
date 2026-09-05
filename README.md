# nff-resale-watch

Watches for tickets to Norway-Denmark (24 Sep 2026) and Norway-Portugal
(27 Sep 2026, both Ullevaal, UEFA Nations League) and pushes a notification to
your phone via [ntfy.sh](https://ntfy.sh). Runs on GitHub Actions every 5 minutes,
started by an external cron (see below).

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
| Denmark or Portugal items listed, or Nations League quantity > 0 | urgent, links to the match page | every run until you stop the job |
| A September match no longer `sold_out` on billett.fotball.no | urgent, links to the shop | every run |
| Some other product has resale tickets | default | once an hour |
| Waiting room blocked a fetch, or a fetch/parse failed | default | once an hour (after 3 attempts inside the run) |
| Everything quiet | low "Still watching" heartbeat with the parsed numbers | daily 08:00 UTC |

"Once an hour" means the run that lands in minutes :00-:04 UTC.

Both sites sit behind a SecuTix virtual waiting room that sometimes redirects a
request to a queue page. Fetches follow redirects with a cookie jar, retry up to
three times, and report `QUEUE` if still blocked, so it is distinguishable from a
real error in the run log:

    2026-09-05T20:20:03Z resale=EMPTY qty=0 denmark=0 portugal=0 shop=SOLDOUT

## Setup

1. Install the ntfy app (Android/iOS) and subscribe to your topic name.
2. Store the topic as a repository secret: `gh secret set NTFY_TOPIC`.
3. Test: `gh workflow run watch-resale` then watch the phone / `gh run list`.
4. Set up the external trigger (next section).

## External trigger (cron-job.org)

GitHub's `schedule` trigger fired only sporadically for this repo, so a free
[cron-job.org](https://cron-job.org) job POSTs to the GitHub API every 5 minutes
and starts the workflow.

1. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: **Only select repositories** -> `nff-resale-watch`.
   - Repository permissions: **Actions: Read and write** (a token with no
     repository permissions gets HTTP 403 from the dispatch endpoint).
   - Expiration: 28 Sep 2026 (the day after the last match).
2. Create a cronjob at <https://console.cron-job.org>:
   - URL: `https://api.github.com/repos/Mikkelnaes/nff-resale-watch/actions/workflows/resale-watch.yml/dispatches`
   - Schedule: every 5 minutes on the marks (0,5,10,...,55). Keep it on the
     marks: the :00 run carries the hourly notices and the 08:00 UTC heartbeat.
   - Advanced -> Request method: `POST`
   - Advanced -> Headers:
     - `Accept: application/vnd.github+json`
     - `Authorization: Bearer <the token from step 1>`
     - `X-GitHub-Api-Version: 2022-11-28`
     - `Content-Type: application/json`
   - Advanced -> Request body: `{"ref":"main"}`
   - Notifications: e-mail on failure. A successful call returns HTTP 204.
3. Verify: `gh run list --repo Mikkelnaes/nff-resale-watch --limit 5` shows a
   new `workflow_dispatch` run every 5 minutes.

## End-to-end test (real phone alert from fixture data)

    gh workflow run watch-resale --repo Mikkelnaes/nff-resale-watch \
      -f catalog_url=https://raw.githubusercontent.com/Mikkelnaes/nff-resale-watch/main/test-fixtures/catalog-hit.json \
      -f items_url_template='https://raw.githubusercontent.com/Mikkelnaes/nff-resale-watch/main/test-fixtures/items-{id}.json' \
      -f shop_url=https://raw.githubusercontent.com/Mikkelnaes/nff-resale-watch/main/test-fixtures/shop-onsale-denmark.html

Expect two urgent pushes: "TICKETS LISTED on NFF resale!" (Denmark: 2 tickets) and
"TICKETS ON SALE at billett.fotball.no!".

## Tests

`bash test_check.sh` (needs `python3` or `python`; no other dependencies).
Fixtures in `test-fixtures/` are real captures from 5 Sep 2026 (`*-empty.json`,
`shop-soldout.html`, `waiting-room.html`) plus synthetic non-empty variants
built on the field semantics used by the site's own JavaScript.

## Stop

Once you have tickets: disable (or delete) the cron-job.org job, run
`gh workflow disable watch-resale`, and delete the token at
<https://github.com/settings/personal-access-tokens>.

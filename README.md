# nff-resale-watch

Polls NFF's official resale page (resale.fotball.no) every 5 minutes from GitHub
Actions and pushes a notification to your phone via [ntfy.sh](https://ntfy.sh)
when tickets for Norway-Denmark or Norway-Portugal (Nations League, Sept 2026)
are listed.

## How it works

- `check.sh` fetches the page. If the "no tickets being resold" text is gone and
  a match name (Danmark/Denmark/Portugal) appears, it publishes an **urgent**
  notification to `https://ntfy.sh/$NTFY_TOPIC` on every run until you stop it.
- A listing for some *other* match, or a failing fetch, is reported once an hour,
  on the run that lands in minutes :00-:04.
- A low-priority "still watching" heartbeat goes out daily at 08:00 UTC.
- `.github/workflows/resale-watch.yml` runs it. The workflow has a 5-minute
  `schedule` cron, but GitHub never fired it for this repo, so the real trigger
  is an external cron (below) that calls the workflow's `workflow_dispatch`
  endpoint. The `concurrency` group keeps the two from overlapping.

## Setup

1. Install the ntfy app (Android/iOS) and subscribe to your topic name.
2. Store the topic as a repository secret: `gh secret set NTFY_TOPIC`.
3. Test: `gh workflow run watch-resale` then watch the phone / `gh run list`.
4. Set up the external trigger (next section).

## External trigger (cron-job.org)

A free [cron-job.org](https://cron-job.org) job POSTs to the GitHub API every
5 minutes and starts the workflow.

1. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: **Only select repositories** -> `nff-resale-watch`.
   - Repository permissions: **Actions: Read and write**. Nothing else.
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
   - Advanced -> Request body: `{"ref":"main"}`
   - Notifications: e-mail on failure. A successful call returns HTTP 204.
3. Verify: `gh run list --repo Mikkelnaes/nff-resale-watch --limit 5` shows a
   new `workflow_dispatch` run every 5 minutes.

The same POST from a terminal, using your `gh` login:

    gh api -X POST repos/Mikkelnaes/nff-resale-watch/actions/workflows/resale-watch.yml/dispatches -f ref=main

## Stop

Once you have tickets: disable (or delete) the cron-job.org job, run
`gh workflow disable watch-resale`, and delete the token at
<https://github.com/settings/personal-access-tokens>.

## Tests

`bash test_check.sh`

# nff-resale-watch

Polls NFF's official resale page (resale.fotball.no) every 5 minutes from GitHub
Actions and pushes a notification to your phone via [ntfy.sh](https://ntfy.sh)
when tickets for Norway-Denmark or Norway-Portugal (Nations League, Sept 2026)
are listed.

## How it works

- `check.sh` fetches the page. If the "no tickets being resold" text is gone and
  a match name (Danmark/Denmark/Portugal) appears, it publishes an **urgent**
  notification to `https://ntfy.sh/$NTFY_TOPIC` on every run until you stop it.
- A listing for some *other* match, or a failing fetch, is reported once an hour.
- A low-priority "still watching" heartbeat goes out daily at 08:00 UTC.
- `.github/workflows/watch.yml` runs it on a 5-minute cron.

## Setup

1. Install the ntfy app (Android/iOS) and subscribe to your topic name.
2. Store the topic as a repository secret: `gh secret set NTFY_TOPIC`.
3. Test: `gh workflow run watch-resale` then watch the phone / `gh run list`.

## Stop

`gh workflow disable watch-resale` (or delete the repo) once you have tickets.

## Tests

`bash test_check.sh`

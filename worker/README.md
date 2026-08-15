# LUXE platform worker (Lightpanda edition)

Polls Supabase `browser_jobs`, executes Airbnb browser automation through
Lightpanda over CDP. Replaces the Playwright ops scripts from LUXE-MSTR.

## Setup (on the VM)

```bash
cd worker
npm install
cp .env.example .env   # fill in
npm start
```

Requires Lightpanda already running: `lightpanda serve --host 127.0.0.1 --port 9222`

## Job kinds (insert into browser_jobs)

| kind | payload | notes |
|---|---|---|
| session_refresh | { login_wait_ms? } | reuses cookies; waits for manual login if expired |
| inbox_sync | { limit? } | reads threads into `messages` |
| send_message | { thread_url?, listing_id?, body, dry_run? } | thread reply OR cold contact via listing |
| scrape_listing | { listing_id, lead_id? } | facts + photos; optionally patches `leads` |

Example — queue a cold outreach:

```sql
insert into browser_jobs (id, kind, status, priority, payload)
values ('bj_' || gen_random_uuid()::text, 'send_message', 'pending', 10,
        '{"listing_id": "7631513", "body": "Hi — ...", "dry_run": true}');
```

## Behaviour notes

- Sends are paced worker-side (SEND_DELAY_MS, default 90s) regardless of how
  many jobs are queued.
- Session failure auto-queues a session_refresh job (self-healing loop).
- dry_run composes the message and clears the composer without sending —
  use it to validate the pathway before going live.
- Live sends require the operator phrase **GO FOR IT** (arms Jarvis + mirrors
  `settings.pipeline_live`) plus `confirm_send=true` on the job. Worker also
  accepts `LUXE_PIPELINE_LIVE=1` as an override. Until armed, dry_run is forced.
- The composer is contenteditable plaintext-only: text is typed via
  Runtime.evaluate DOM writes (not fragile Input.* key events).

## Session bootstrap (operator)

Epoch `platform_sessions` rows are ignored. After Lightpanda + worker are up:

```bash
# Copy path works with Chrome open on macOS. Does not print cookie/JWT values.
# Requires a real Chrome login with `_jwt` on airbnb.com OR airbnb.ca
# (CA vs COM are separate; worker navigates whichever TLD has `_jwt`).
python3 scripts/airbnb_cookie_push.py
# Or queue session_refresh after a valid Airbnb login is available to the worker.
```

Then smoke (dry-run outreach only):

```bash
python3 scripts/jarvis_wire_check.py
python3 scripts/pipeline_smoke.py
```

See `docs/PIPELINE_LIVE_GATE.md` and `luxe-cortex/docs/vm-systemd-units.md`.

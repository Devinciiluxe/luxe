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
- The composer is contenteditable plaintext-only: text is typed as real
  keystrokes, never set via .value (Airbnb ignores that).

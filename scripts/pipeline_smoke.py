#!/usr/bin/env python3
"""Real-data pipeline smoke (dry-run outreach only).

Sequence:
  1) queue session_refresh (optional skip via SMOKE_SKIP_REFRESH=1)
  2) queue inbox_sync (small limit)
  3) confirm messages with category=inbox_sync (best-effort)
  4) optional scrape_listing if SMOKE_LISTING_ID set
  5) dry-run send_message only (never live — GO FOR IT is a separate gate)

Does NOT send Airbnb messages. Uses same credentials as pipeline_audit.py.

Exit codes:
  0  inbox_sync done and at least one inbox_sync message exists
  2  job finished failed (session / Lightpanda) — infrastructure gap recorded
  1  timeout or API error

Environment:
  SMOKE_TIMEOUT_S          per-job wait (default 90)
  SMOKE_SKIP_REFRESH=1     skip session_refresh step
  SMOKE_LISTING_ID=…       also queue scrape_listing + dry-run send_message
  SMOKE_SEND_BODY=…        body for dry-run send (default smoke text)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG_PATH = ROOT / "Jarvis-cortex" / "config" / "api_keys.json"


def _cfg() -> dict:
    try:
        return json.loads(CFG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


cfg = _cfg()
SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or cfg.get("luxe_supabase_url")
    or "https://vbswmotdtyqakzuzkqui.supabase.co"
).rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or cfg.get("luxe_supabase_service_key") or ""
TIMEOUT_S = int(os.environ.get("SMOKE_TIMEOUT_S", "90"))
SKIP_REFRESH = os.environ.get("SMOKE_SKIP_REFRESH", "").strip() in ("1", "true", "TRUE")
LISTING_ID = (os.environ.get("SMOKE_LISTING_ID") or "").strip()
SEND_BODY = (
    os.environ.get("SMOKE_SEND_BODY")
    or "[LUXE smoke] dry-run only — not a real host message."
).strip()


def rest(method: str, path: str, body=None, params: str = ""):
    url = f"{SUPABASE_URL}/rest/v1/{path}{params}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Content-Type", "application/json")
    if method == "POST":
        req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": e.read().decode(errors="replace"), "status": e.code}


def queue_job(kind: str, payload: dict, priority: int = 10) -> str:
    job_id = f"bj_smoke_{uuid.uuid4().hex[:16]}"
    print(f"[smoke] queue {kind} {job_id}")
    inserted = rest(
        "POST",
        "browser_jobs",
        body=[{
            "id": job_id,
            "kind": kind,
            "status": "pending",
            "priority": priority,
            "payload": payload,
        }],
    )
    if isinstance(inserted, dict) and inserted.get("ok") is False:
        raise RuntimeError(f"queue {kind} failed: {inserted.get('error')}")
    return job_id


def wait_job(job_id: str) -> dict | None:
    deadline = time.time() + TIMEOUT_S
    job = None
    while time.time() < deadline:
        rows = rest(
            "GET",
            "browser_jobs",
            params=f"?id=eq.{job_id}&select=id,kind,status,error,result,done_at",
        )
        if isinstance(rows, list) and rows:
            job = rows[0]
            st = job.get("status")
            print(f"[smoke] {job.get('kind')} status={st}")
            if st in ("done", "failed"):
                return job
        time.sleep(3)
    print(f"[smoke] timeout after {TIMEOUT_S}s waiting for {job_id}", file=sys.stderr)
    return job


def main() -> int:
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY not set", file=sys.stderr)
        return 1

    print(
        "[smoke] sequence: session_refresh → inbox_sync → confirm messages"
        + (" → scrape_listing → dry-run send_message" if LISTING_ID else "")
        + " (outreach always dry_run; GO FOR IT is a separate gate)",
        flush=True,
    )

    try:
        if not SKIP_REFRESH:
            rid = queue_job("session_refresh", {"source": "pipeline_smoke"}, priority=100)
            rjob = wait_job(rid)
            print(f"[smoke] session_refresh → {json.dumps(rjob, default=str)[:400]}")
            if rjob and rjob.get("status") == "failed":
                print(
                    f"[smoke] session_refresh failed: {rjob.get('error')} "
                    "(continue to inbox_sync — may still fail without cookies)",
                    flush=True,
                )
        else:
            print("[smoke] skipping session_refresh (SMOKE_SKIP_REFRESH=1)")

        inbox_id = queue_job(
            "inbox_sync",
            {"limit": 5, "source": "pipeline_smoke"},
            priority=10,
        )
        job = wait_job(inbox_id)
        if not job:
            return 1

        msgs = rest(
            "GET",
            "messages",
            params="?category=eq.inbox_sync&select=id&limit=1",
        )
        msg_n = len(msgs) if isinstance(msgs, list) else 0
        print(f"[smoke] job={json.dumps(job, default=str)}")
        print(f"[smoke] inbox_sync messages present: {msg_n}")

        if LISTING_ID:
            sid = queue_job(
                "scrape_listing",
                {"listing_id": LISTING_ID, "source": "pipeline_smoke"},
            )
            sjob = wait_job(sid)
            print(f"[smoke] scrape_listing → {json.dumps(sjob, default=str)[:400]}")

            # Always force dry_run — never honor GO FOR IT inside this smoke script.
            send_id = queue_job(
                "send_message",
                {
                    "listing_id": LISTING_ID,
                    "body": SEND_BODY,
                    "dry_run": True,
                    "source": "pipeline_smoke",
                },
            )
            send_job = wait_job(send_id)
            print(f"[smoke] send_message dry_run → {json.dumps(send_job, default=str)[:400]}")

        if job.get("status") == "done" and msg_n > 0:
            print("[smoke] PASS — inbox data recorded")
            return 0
        if job.get("status") == "failed":
            print(f"[smoke] FAIL (worker ran): {job.get('error')}")
            print(
                "[smoke] next: fix SSH ServerAliveInterval in ~/.ssh/config, "
                "run deploy/install-vm.sh, then python3 scripts/airbnb_cookie_push.py",
            )
            return 2
        if job.get("status") == "pending" or job.get("status") == "claimed":
            print(
                f"[smoke] FAIL — job still {job.get('status')} after {TIMEOUT_S}s "
                "(VM worker/Lightpanda not claiming — run deploy/install-vm.sh on the VM)",
            )
            return 1
        print("[smoke] FAIL — job finished but no inbox_sync messages")
        return 2
    except Exception as e:
        print(f"[smoke] ERROR {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

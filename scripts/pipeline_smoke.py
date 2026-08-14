#!/usr/bin/env python3
"""Queue a dry inbox_sync job and wait for the worker to finish it.

Does NOT send Airbnb messages. Uses the same credentials as pipeline_audit.py.

Exit codes:
  0  job done and at least one inbox_sync message exists
  2  job finished failed (session / Lightpanda) — infrastructure gap recorded
  1  timeout or API error
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
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


def main() -> int:
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY not set", file=sys.stderr)
        return 1

    job_id = f"bj_smoke_{uuid.uuid4().hex[:16]}"
    payload = {"limit": 5, "source": "pipeline_smoke"}
    print(f"[smoke] queue inbox_sync {job_id}")
    inserted = rest("POST", "browser_jobs", body=[{
        "id": job_id,
        "kind": "inbox_sync",
        "status": "pending",
        "priority": 10,
        "payload": payload,
    }])
    if isinstance(inserted, dict) and inserted.get("ok") is False:
        print(f"[smoke] queue failed: {inserted.get('error')}", file=sys.stderr)
        return 1

    deadline = time.time() + TIMEOUT_S
    job = None
    while time.time() < deadline:
        rows = rest("GET", "browser_jobs", params=f"?id=eq.{job_id}&select=id,status,error,result,done_at")
        if isinstance(rows, list) and rows:
            job = rows[0]
            st = job.get("status")
            print(f"[smoke] status={st}")
            if st in ("done", "failed"):
                break
        time.sleep(3)
    else:
        print(f"[smoke] timeout after {TIMEOUT_S}s — worker may be down", file=sys.stderr)
        return 1

    msgs = rest(
        "GET",
        "messages",
        params="?category=eq.inbox_sync&select=id&limit=1",
    )
    msg_n = len(msgs) if isinstance(msgs, list) else 0
    print(f"[smoke] job={json.dumps(job, default=str)}")
    print(f"[smoke] inbox_sync messages present: {msg_n}")

    if job.get("status") == "done" and msg_n > 0:
        print("[smoke] PASS — inbox data recorded")
        return 0
    if job.get("status") == "failed":
        print(f"[smoke] FAIL (worker ran): {job.get('error')}")
        print("[smoke] next: python3 scripts/airbnb_cookie_push.py then re-run")
        return 2
    print("[smoke] FAIL — job done but no messages")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

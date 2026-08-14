#!/usr/bin/env python3
"""Always-on headless pipeline watcher for the VM (no GUI, no secrets printed).

Polls luxe_supabase_REAL_PIPELINE status / watch_jobs and, when the session
looks dead (epoch/STALE), queues a session_refresh job. Keeps the 24/7 loop
alive when the operator's Mac (and PyQt Jarvis UI) is off.

Writes Jarvis-cortex/config/pipeline_daemon.heartbeat for operators/monitoring.

Does NOT arm live sends. Dry-run stays default unless GO FOR IT was armed
elsewhere (local file + Supabase settings.pipeline_live mirror). Never prints
API keys or cookie values.

  python3 scripts/jarvis_pipeline_watch.py
  WATCH_INTERVAL_S=60 python3 scripts/jarvis_pipeline_watch.py

systemd: deploy/systemd/luxe-pipeline-watch.service
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "Jarvis-cortex"))

from actions.luxe_supabase import luxe_supabase  # noqa: E402
from actions.pipeline_arm import is_pipeline_armed  # noqa: E402

INTERVAL = int(os.environ.get("WATCH_INTERVAL_S", "60"))
HEARTBEAT = Path(
    os.environ.get(
        "JARVIS_WATCH_HEARTBEAT",
        str(ROOT / "Jarvis-cortex" / "config" / "pipeline_daemon.heartbeat"),
    )
)
AUTO_REFRESH = os.environ.get("JARVIS_WATCH_AUTO_REFRESH", "1").strip() not in (
    "0",
    "false",
    "FALSE",
    "no",
)


def _beat(payload: dict) -> None:
    HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
    HEARTBEAT.write_text(
        json.dumps(
            {
                **payload,
                "ts": datetime.now(timezone.utc).isoformat(),
                "armed": is_pipeline_armed(),
                "pid": os.getpid(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _tick() -> None:
    status = luxe_supabase({"action": "pipeline_status"})
    health = luxe_supabase({"action": "worker_health"})
    live = luxe_supabase({"action": "live_status"})
    watch = luxe_supabase({"action": "watch_jobs", "limit": 10})
    # Opaque logs — no credentials, no cookie dumps.
    print(f"[watch] {status}", flush=True)
    print(f"[watch] {health}", flush=True)
    print(f"[watch] {live}", flush=True)
    print(f"[watch] {watch}", flush=True)

    hl = health.lower()
    bad = (
        "don't see any" in hl
        or "expired" in hl
        or "epoch" in hl
        or "stale" in hl
        or "1970-01-01" in health
    )
    queued = None
    if bad and AUTO_REFRESH:
        queued = luxe_supabase(
            {"action": "queue_job", "kind": "session_refresh", "job_payload": {}}
        )
        # Unique partial index may reject a second pending refresh — that is fine.
        if isinstance(queued, str) and (
            "already exists" in queued.lower() or "duplicate" in queued.lower()
        ):
            queued = "session_refresh already pending (ok)"
        print(f"[watch] auto-queued session_refresh → {queued}", flush=True)

    _beat(
        {
            "ok": not status.startswith("Sir, I couldn't") and "isn't configured" not in status,
            "session_stale": bad,
            "pipeline_status": status[:400],
            "worker_health": health[:400],
            "watch_jobs": watch[:500],
            "auto_session_refresh": (queued or "")[:200],
        }
    )


def main() -> int:
    print(
        f"[watch] starting interval={INTERVAL}s heartbeat={HEARTBEAT} "
        f"auto_refresh={AUTO_REFRESH} (dry-run default; GO FOR IT arms live elsewhere)",
        flush=True,
    )
    while True:
        try:
            _tick()
        except Exception as e:
            _beat({"ok": False, "error": f"{type(e).__name__}: {e}"})
            print(f"[watch] tick error {type(e).__name__}: {e}", flush=True)
        time.sleep(max(10, INTERVAL))


if __name__ == "__main__":
    raise SystemExit(main())

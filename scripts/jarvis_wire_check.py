#!/usr/bin/env python3
"""Verify Jarvis + cortex share the same Supabase lead truth.

1) luxe_supabase pipeline_status lead count (PostgREST, same as voice tools)
2) Optional: GET luxe-cortex /api/jarvis metrics.activeNodes / leads length
   when JARVIS_API_KEY + LUXE_CORTEX_URL are set — must match within paging.

Exit 0 only if Supabase answers with a real lead count.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "Jarvis-cortex"))

from actions.luxe_supabase import luxe_supabase  # noqa: E402

_LEAD_COUNT_RE = re.compile(r"^(\d+)\s+leads\s+in\s+the\s+pipeline", re.IGNORECASE)


def _cortex_lead_count() -> int | None:
    cfg_path = Path(__file__).resolve().parent.parent / "Jarvis-cortex" / "config" / "api_keys.json"
    cfg: dict = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            cfg = {}
    key = os.environ.get("JARVIS_API_KEY") or cfg.get("jarvis_api_key") or ""
    base = (
        os.environ.get("LUXE_CORTEX_URL")
        or cfg.get("luxe_cortex_url")
        or "http://localhost:8787"
    ).rstrip("/")
    if not key:
        return None
    req = urllib.request.Request(f"{base}/api/jarvis", method="GET")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"[cortex] skip compare: {type(e).__name__}: {e}")
        return None
    if not data.get("ok"):
        print(f"[cortex] skip compare: {data.get('error')}")
        return None
    leads = data.get("leads") or []
    metrics = data.get("metrics") or {}
    n = len(leads)
    active = metrics.get("activeNodes")
    print(f"[cortex /api/jarvis] leads={n} activeNodes={active}")
    return n


def main() -> int:
    try:
        status = luxe_supabase({"action": "pipeline_status"})
        print(f"[pipeline_status] {status}")
        m = _LEAD_COUNT_RE.match(status.strip())
        if not m:
            print("FAIL: pipeline_status did not return a lead count line", file=sys.stderr)
            return 1
        lead_n = int(m.group(1))
        if lead_n < 1:
            print(f"FAIL: expected real leads, got {lead_n}", file=sys.stderr)
            return 1
        if status.startswith("Sir, I couldn't") or "isn't configured" in status:
            print("FAIL: pipeline_status error", file=sys.stderr)
            return 1
        print(f"OK: {lead_n} Supabase leads (luxe_supabase)")

        cortex_n = _cortex_lead_count()
        if cortex_n is not None:
            if cortex_n != lead_n:
                print(
                    f"FAIL: cortex leads ({cortex_n}) != supabase pipeline_status ({lead_n})",
                    file=sys.stderr,
                )
                return 1
            print(f"OK: cortex allLeads count matches ({cortex_n})")

        health = luxe_supabase({"action": "worker_health"})
        print(f"[worker_health] {health}")
        if health.startswith("Sir, I couldn't") and "platform_sessions" in health:
            print("FAIL: worker_health transport error", file=sys.stderr)
            return 1

        jobs = luxe_supabase({"action": "job_status"})
        print(f"[job_status] {jobs}")
        if jobs.startswith("Sir, I couldn't"):
            print("FAIL: job_status error", file=sys.stderr)
            return 1
        if not (
            jobs.startswith("Recent jobs:")
            or jobs.startswith("No browser jobs")
        ):
            print("FAIL: job_status unexpected shape", file=sys.stderr)
            return 1

        return 0
    except Exception as e:
        print(f"FAIL: exception {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

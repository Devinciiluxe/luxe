#!/usr/bin/env python3
"""Verify Jarvis can reach the real pipeline (same tools as voice).

Prints pipeline_status, worker_health, job_status. Exit 0 if Supabase answers.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "Jarvis-cortex"))

from actions.luxe_supabase import luxe_supabase  # noqa: E402


def main() -> int:
    for action in ("pipeline_status", "worker_health", "job_status"):
        out = luxe_supabase({"action": action})
        print(f"[{action}] {out}")
        if out.startswith("Sir, I couldn't") or "isn't configured" in out:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Always-on Jarvis pipeline daemon (headless).

Thin entrypoint so systemd / operators can start:
  python3 Jarvis-cortex/pipeline_daemon.py

Delegates to scripts/jarvis_pipeline_watch.py — same watch loop, heartbeat at
config/pipeline_daemon.heartbeat, auto session_refresh when stale.

Does not arm live sends. Dry-run stays default until GO FOR IT elsewhere.
"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

_WATCH = Path(__file__).resolve().parent.parent / "scripts" / "jarvis_pipeline_watch.py"


def main() -> int:
    if not _WATCH.is_file():
        print(f"missing watcher: {_WATCH}", file=sys.stderr)
        return 1
    runpy.run_path(str(_WATCH), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Read-only LUXE / JARVIS pipeline audit against Supabase.

Pulls inbox_sync jobs, inbox messages, send_message jobs, platform sessions,
and Airbnb leads — then computes integrity checks for the canvas.

Usage:
  python3 scripts/pipeline_audit.py
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/pipeline_audit.py

Credentials: env SUPABASE_URL / SUPABASE_SERVICE_KEY, or
Jarvis-cortex/config/api_keys.json (luxe_supabase_url / luxe_supabase_service_key).

Writes: scripts/audit-output.json
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = Path(__file__).resolve().parent / "audit-output.json"
CFG_PATH = ROOT / "Jarvis-cortex" / "config" / "api_keys.json"


def _load_cfg() -> dict:
    try:
        return json.loads(CFG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


_cfg = _load_cfg()
SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or _cfg.get("luxe_supabase_url")
    or "https://vbswmotdtyqakzuzkqui.supabase.co"
).rstrip("/")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_KEY")
    or _cfg.get("luxe_supabase_service_key")
    or ""
)


def _rest(path: str, params: str = "", timeout: int = 60) -> list | dict:
    url = f"{SUPABASE_URL}/rest/v1/{path}{params}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Accept", "application/json")
    # Prefer exact count when available
    req.add_header("Prefer", "count=exact")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            err = json.loads(body)
        except Exception:
            err = {"message": body or f"HTTP {e.code}"}
        return {"ok": False, "error": err, "status": e.code}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _paged(path: str, select: str, filters: str = "", page_size: int = 1000, max_rows: int = 10000) -> list:
    """Fetch rows with limit/offset pagination."""
    rows: list = []
    offset = 0
    while offset < max_rows:
        q = f"?select={urllib.parse.quote(select, safe=',.()')}{filters}&limit={page_size}&offset={offset}"
        batch = _rest(path, q)
        if isinstance(batch, dict) and not batch.get("ok", True):
            raise RuntimeError(f"Supabase {path} failed: {batch.get('error')}")
        if not isinstance(batch, list):
            raise RuntimeError(f"Unexpected response for {path}: {type(batch)}")
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def _parse_meta(raw) -> dict:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw) if raw else {}
        except Exception:
            return {}
    return {}


def _parse_result(raw) -> dict:
    return _parse_meta(raw)


def _day(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        # Accept date or datetime
        return iso[:10]
    except Exception:
        return None


def main() -> int:
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY (or luxe_supabase_service_key) is not set.", file=sys.stderr)
        return 1

    exported_at = datetime.now(timezone.utc).isoformat()
    print(f"[audit] querying {SUPABASE_URL} …")

    inbox_jobs = _paged(
        "browser_jobs",
        "id,kind,status,priority,payload,result,error,attempts,created_at,claimed_at,done_at",
        "&kind=eq.inbox_sync&order=created_at.desc",
        max_rows=2000,
    )
    print(f"[audit] inbox_sync jobs: {len(inbox_jobs)}")

    send_jobs = _paged(
        "browser_jobs",
        "id,kind,status,priority,payload,result,error,attempts,created_at,claimed_at,done_at",
        "&kind=eq.send_message&order=created_at.desc",
        max_rows=2000,
    )
    print(f"[audit] send_message jobs: {len(send_jobs)}")

    inbox_msgs = _paged(
        "messages",
        "id,lead_id,direction,channel,category,sent_as,body,meta,created_at",
        "&category=eq.inbox_sync&order=created_at.desc",
        max_rows=10000,
    )
    print(f"[audit] inbox_sync messages: {len(inbox_msgs)}")

    sessions = _paged(
        "platform_sessions",
        "id,status,error_count,last_used_at,created_at,updated_at,platform",
        "&order=last_used_at.desc",
        max_rows=50,
    )
    print(f"[audit] platform_sessions: {len(sessions)}")

    # Sample of Airbnb leads for linkage
    airbnb_leads = _paged(
        "leads",
        "id,status,source_platform,contact_route,property_name,updated_at",
        "&source_platform=eq.airbnb&order=updated_at.desc",
        max_rows=5000,
    )
    print(f"[audit] airbnb leads (capped): {len(airbnb_leads)}")

    # Broader lead pull for linkage + pipeline status mix
    all_lead_rows = _paged(
        "leads",
        "id,status,track,contact_route,source_platform",
        "",
        page_size=1000,
        max_rows=8000,
    )
    all_lead_ids = {r["id"] for r in all_lead_rows if r.get("id")}
    leads_by_status = Counter(r.get("status") or "unknown" for r in all_lead_rows)
    leads_by_track = Counter(r.get("track") or "unknown" for r in all_lead_rows)
    leads_by_platform = Counter(r.get("source_platform") or "(null)" for r in all_lead_rows)
    print(f"[audit] lead ids for linkage: {len(all_lead_ids)}")

    # --- Job status breakdown ---
    inbox_status = Counter(j.get("status") or "unknown" for j in inbox_jobs)
    send_status = Counter(j.get("status") or "unknown" for j in send_jobs)

    # --- Job vs message gap ---
    job_gaps = []
    total_threads_found = 0
    total_synced_claimed = 0
    for j in inbox_jobs:
        if j.get("status") != "done":
            continue
        result = _parse_result(j.get("result"))
        threads_found = int(result.get("threads_found") or 0)
        synced = int(result.get("synced") or 0)
        total_threads_found += threads_found
        total_synced_claimed += synced
        claimed = j.get("claimed_at")
        done = j.get("done_at")
        # Count messages whose scraped_at falls in [claimed_at, done_at]
        matched = 0
        if claimed and done:
            for m in inbox_msgs:
                meta = _parse_meta(m.get("meta"))
                scraped = meta.get("scraped_at") or m.get("created_at")
                if scraped and claimed <= scraped <= done:
                    matched += 1
        gap = {
            "job_id": j.get("id"),
            "threads_found": threads_found,
            "synced_claimed": synced,
            "msgs_in_window": matched if claimed and done else None,
            "claimed_at": claimed,
            "done_at": done,
            "error": j.get("error") or None,
        }
        if synced != matched and claimed and done:
            gap["flag"] = "synced_vs_window_mismatch"
            job_gaps.append(gap)
        elif synced < threads_found:
            gap["flag"] = "partial_sync"
            job_gaps.append(gap)
        elif synced == 0 and threads_found > 0:
            gap["flag"] = "zero_synced"
            job_gaps.append(gap)

    # --- Thread coverage & duplicates ---
    thread_counts: dict[str, int] = Counter()
    thread_examples: dict[str, dict] = {}
    daily: Counter = Counter()
    unlinked_lead = []
    for m in inbox_msgs:
        meta = _parse_meta(m.get("meta"))
        tid = str(meta.get("thread_id") or m.get("lead_id") or "")
        if tid:
            thread_counts[tid] += 1
            if tid not in thread_examples:
                thread_examples[tid] = {
                    "thread_id": tid,
                    "lead_id": m.get("lead_id"),
                    "with_name": meta.get("with_name"),
                    "listing_id": meta.get("listing_id"),
                    "message_count": meta.get("message_count"),
                    "scraped_at": meta.get("scraped_at"),
                }
        scraped = meta.get("scraped_at") or m.get("created_at")
        d = _day(scraped)
        if d:
            daily[d] += 1
        lid = m.get("lead_id")
        if lid and lid not in all_lead_ids:
            unlinked_lead.append({
                "message_id": m.get("id"),
                "lead_id": lid,
                "thread_id": meta.get("thread_id"),
                "scraped_at": meta.get("scraped_at"),
            })

    duplicates = [
        {
            "thread_id": tid,
            "sync_rows": n,
            **{k: v for k, v in thread_examples.get(tid, {}).items() if k != "thread_id"},
        }
        for tid, n in thread_counts.most_common()
        if n > 1
    ]

    # --- Failed jobs table ---
    failed_inbox = [
        {
            "id": j.get("id"),
            "status": j.get("status"),
            "error": (j.get("error") or "")[:300],
            "attempts": j.get("attempts"),
            "created_at": j.get("created_at"),
            "done_at": j.get("done_at"),
        }
        for j in inbox_jobs
        if j.get("status") == "failed"
    ]

    # --- Outbound verification ---
    outbound = []
    outbound_verified = 0
    outbound_dry = 0
    outbound_unverified = 0
    for j in send_jobs:
        result = _parse_result(j.get("result"))
        payload = _parse_meta(j.get("payload"))
        dry = bool(result.get("dry_run") if "dry_run" in result else payload.get("dry_run"))
        verified = bool(result.get("verified"))
        if dry:
            outbound_dry += 1
        elif verified:
            outbound_verified += 1
        elif j.get("status") == "done":
            outbound_unverified += 1
        outbound.append({
            "id": j.get("id"),
            "status": j.get("status"),
            "dry_run": dry,
            "verified": verified,
            "error": (j.get("error") or "")[:200] or None,
            "created_at": j.get("created_at"),
            "done_at": j.get("done_at"),
        })

    # --- Session health ---
    session_summary = None
    if sessions:
        s = sessions[0]
        session_summary = {
            "status": s.get("status"),
            "error_count": s.get("error_count") or 0,
            "last_used_at": s.get("last_used_at"),
            "platform": s.get("platform"),
            "id": s.get("id"),
            "total_sessions": len(sessions),
        }

    # --- Airbnb lead status breakdown ---
    airbnb_by_status = Counter(r.get("status") or "unknown" for r in airbnb_leads)

    # --- Callouts / actionable gaps ---
    callouts = []
    done_count = inbox_status.get("done", 0)
    failed_count = inbox_status.get("failed", 0)
    total_inbox_jobs = len(inbox_jobs)
    success_rate = round(100.0 * done_count / total_inbox_jobs, 1) if total_inbox_jobs else None

    if failed_count:
        callouts.append(f"{failed_count} inbox_sync job(s) failed — check worker session / Lightpanda.")
    if duplicates:
        callouts.append(
            f"{len(duplicates)} thread(s) synced more than once (INSERT-only inbox_sync; no upsert)."
        )
    zero_sync_jobs = sum(
        1
        for j in inbox_jobs
        if j.get("status") == "done"
        and int(_parse_result(j.get("result")).get("synced") or 0) == 0
        and int(_parse_result(j.get("result")).get("threads_found") or 0) > 0
    )
    if zero_sync_jobs:
        callouts.append(f"{zero_sync_jobs} done job(s) found threads but synced 0.")
    if unlinked_lead:
        callouts.append(
            f"{len(unlinked_lead)} inbox_sync message(s) use lead_id that is not a real leads.id "
            "(likely Airbnb thread_id fallback)."
        )
    if outbound_unverified:
        callouts.append(
            f"{outbound_unverified} send_message job(s) marked done without result.verified=true."
        )
    if session_summary and str(session_summary.get("last_used_at") or "").startswith("1970"):
        callouts.append(
            "platform_sessions.last_used_at is epoch (1970) — cookies may never have been used by the worker."
        )
    if session_summary and session_summary.get("status") not in ("ok", "active", "valid", "ready"):
        # Don't over-alarm on unknown statuses; note if errors
        if (session_summary.get("error_count") or 0) > 0:
            callouts.append(
                f"Worker session has {session_summary['error_count']} error(s); "
                f"status={session_summary.get('status')}."
            )
    if inbox_jobs and not inbox_msgs:
        callouts.append(
            "inbox_sync jobs exist but zero messages were recorded — no Airbnb inbox data reached the CRM."
        )
    if not inbox_jobs and not inbox_msgs:
        callouts.append("No inbox_sync jobs or messages found — worker may never have run inbox_sync.")
    if not callouts:
        callouts.append("No critical integrity gaps detected in this snapshot.")

    # Daily series sorted
    daily_series = [{"date": d, "messages": daily[d]} for d in sorted(daily.keys())]

    # Status chart data
    status_chart = [
        {"status": k, "count": inbox_status[k]}
        for k in ("pending", "claimed", "done", "failed")
        if inbox_status.get(k)
    ]
    # Include any other statuses
    for k, v in inbox_status.items():
        if k not in ("pending", "claimed", "done", "failed"):
            status_chart.append({"status": k, "count": v})

    audit = {
        "exported_at": exported_at,
        "source": SUPABASE_URL,
        "summary": {
            "inbox_sync_jobs": total_inbox_jobs,
            "inbox_sync_done": done_count,
            "inbox_sync_failed": failed_count,
            "inbox_sync_success_rate_pct": success_rate,
            "inbox_sync_messages": len(inbox_msgs),
            "unique_threads": len(thread_counts),
            "duplicate_threads": len(duplicates),
            "threads_found_sum": total_threads_found,
            "synced_claimed_sum": total_synced_claimed,
            "unlinked_lead_messages": len(unlinked_lead),
            "send_message_jobs": len(send_jobs),
            "outbound_verified": outbound_verified,
            "outbound_dry_run": outbound_dry,
            "outbound_unverified": outbound_unverified,
            "airbnb_leads_sampled": len(airbnb_leads),
            "pipeline_leads_sampled": len(all_lead_rows),
            "session": session_summary,
        },
        "inbox_job_status": dict(inbox_status),
        "send_job_status": dict(send_status),
        "status_chart": status_chart,
        "daily_messages": daily_series,
        "failed_jobs": failed_inbox[:50],
        "job_gaps": job_gaps[:50],
        "duplicates": duplicates[:50],
        "unlinked_leads": unlinked_lead[:50],
        "outbound_jobs": outbound[:40],
        "airbnb_leads_by_status": dict(airbnb_by_status),
        "leads_by_status": dict(leads_by_status),
        "leads_by_track": dict(leads_by_track),
        "leads_by_source_platform": dict(leads_by_platform),
        "callouts": callouts,
        "recent_inbox_jobs": [
            {
                "id": j.get("id"),
                "status": j.get("status"),
                "threads_found": _parse_result(j.get("result")).get("threads_found"),
                "synced": _parse_result(j.get("result")).get("synced"),
                "error": (j.get("error") or "")[:120] or None,
                "created_at": j.get("created_at"),
                "done_at": j.get("done_at"),
            }
            for j in inbox_jobs[:25]
        ],
    }

    OUT_PATH.write_text(json.dumps(audit, indent=2, default=str), encoding="utf-8")
    print(f"[audit] wrote {OUT_PATH}")
    print(f"[audit] success_rate={success_rate}% msgs={len(inbox_msgs)} threads={len(thread_counts)} dups={len(duplicates)}")
    for c in callouts:
        print(f"  • {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

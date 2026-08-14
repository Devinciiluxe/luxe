"""Client for the `vbswmotdtyqakzuzkqui` Supabase project — the real ops
pipeline (5,000+ leads, browser_jobs worker on the VM, Airbnb outreach
automation). Note the separate project *named* "LUXE PIPELINE"
(dnnagfjwctjtrliftolb) is dead (RESTORE_FAILED) and holds none of this data.

This module is the SOLE source of truth for Jarvis-spoken pipeline stats —
same PostgREST tables luxe-cortex allLeads()/computeMetrics() read. Root
dashboard/ (mission-data.js) is demo-only and must never be used for ops.

JARVIS can read pipeline status/leads and queue the SAFE job kinds
(session_refresh, inbox_sync, scrape_listing) outright.

send_message is also queueable, but is NOT a safe kind: it sends a real
outbound message to a real person over Airbnb. It is gated rather than
blocked:

  1. Dry-run stays ON until the operator says the exact phrase "GO FOR IT"
     (case-sensitive). That arms LIVE SENDS only — stats are always live.
  2. Even when armed, each send_message still needs confirm_send=true in
     the same request — a second safety so a misheard command cannot DM.

See pipeline_arm.py for the arming gate.
"""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from actions.pipeline_arm import (
    arm_from_phrase,
    disarm_pipeline,
    is_pipeline_armed,
)

_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "api_keys.json"


def _load_cfg() -> dict:
    # An absent config file is a normal condition (env vars may supply the
    # credentials instead). A malformed one is not, so it raises rather than
    # silently degrading to an empty config and an "isn't configured" message
    # that would point at the wrong cause.
    if not _CFG_PATH.is_file():
        return {}
    return json.loads(_CFG_PATH.read_text())


_cfg = _load_cfg()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "") or _cfg.get("luxe_supabase_url", "https://vbswmotdtyqakzuzkqui.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "") or _cfg.get("luxe_supabase_service_key", "")

SAFE_JOB_KINDS = {"session_refresh", "inbox_sync", "scrape_listing"}


def _send(req: "urllib.request.Request") -> "dict | list":
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return {"ok": False, "error": json.loads(raw)}
        except json.JSONDecodeError:
            return {"ok": False, "error": f"HTTP {e.code} {e.reason}: {raw[:200]}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"cannot reach {SUPABASE_URL}: {e.reason}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _rest_get(path: str, params: str = "") -> "dict | list":
    return _send(urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}{params}", method="GET"))


def _rest_post(path: str, body: "dict | list") -> "dict | list":
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}", data=json.dumps(body).encode(), method="POST"
    )
    req.add_header("Prefer", "return=representation")
    return _send(req)


def _as_list(resp: "dict | list", label: str) -> "list | None":
    """PostgREST success is a JSON array; error envelopes are dicts with ok=False."""
    if isinstance(resp, dict) and resp.get("ok") is False:
        return None
    if not isinstance(resp, list):
        return None
    return resp


def luxe_supabase(parameters: dict) -> str:
    if not SUPABASE_KEY:
        return "Sir, the pipeline Supabase key isn't configured."

    action = (parameters.get("action", "")).strip()

    if action == "arm_live":
        # Operator must pass the exact arming phrase; model cannot invent it.
        phrase = parameters.get("phrase") or parameters.get("go_for_it_phrase") or ""
        if arm_from_phrase(str(phrase)):
            return (
                "Pipeline is now ARMED for live Airbnb sends, sir. "
                "Lead counts and job stats were already live from Supabase — arming does not change stats. "
                "Individual Airbnb DMs still need confirm_send=true on each queue_job. "
                "To return to dry-run sends, call disarm_live or remove config/pipeline_live.armed "
                "(or unset LUXE_PIPELINE_LIVE)."
            )
        return (
            "Sir, I cannot arm the pipeline — say the exact phrase GO FOR IT "
            "(those three words, that capitalization)."
        )

    if action == "disarm_live":
        disarm_pipeline()
        return (
            "Pipeline DISARMED — dry-run is back on for all send_message jobs, sir. "
            "Say GO FOR IT again when you want live mode."
        )

    if action == "live_status":
        armed = is_pipeline_armed()
        return (
            f"Send mode is {'ARMED (live Airbnb DMs allowed with confirm_send)' if armed else 'DISARMED (dry-run default)'}. "
            "Lead counts and job stats are always from live Supabase and do not require arming. "
            "Arming phrase for SENDS is the exact words GO FOR IT. Disarm with disarm_live."
        )

    if action == "watch_jobs":
        # Live loop snapshot for Jarvis to narrate the claim→process→status cycle.
        limit = int(parameters.get("limit") or 15)
        limit = max(1, min(limit, 50))
        rows = _rest_get(
            "browser_jobs",
            params=(
                f"?select=id,kind,status,error,created_at,done_at,claimed_at"
                f"&order=created_at.desc&limit={limit}"
            ),
        )
        if isinstance(rows, dict) and rows.get("ok") is False:
            return f"Sir, I couldn't watch the job queue: {rows.get('error')}"
        job_list = _as_list(rows, "browser_jobs")
        if job_list is None:
            return "Sir, I couldn't watch the job queue."
        if not job_list:
            return "Job queue is empty — nothing cycling right now."
        by_status: dict[str, int] = {}
        lines: list[str] = []
        for j in job_list:
            if not isinstance(j, dict):
                continue
            st = str(j.get("status") or "unknown")
            by_status[st] = by_status.get(st, 0) + 1
            kind = j.get("kind") or "?"
            err = (j.get("error") or "")[:80]
            tail = f" err={err}" if err and st == "failed" else ""
            lines.append(f"{kind}:{st}{tail}")
        summary = ", ".join(f"{v} {k}" for k, v in sorted(by_status.items(), key=lambda x: -x[1]))
        return f"Watching queue ({summary}). Latest: " + "; ".join(lines[:8])

    if action == "pipeline_status":
        # PostgREST caps every response at 1000 rows, so "limit=1500" silently
        # returned 1000 of 5065 leads and reported that as the whole pipeline.
        # Page with offset until a short page comes back, so the count is the
        # real one.
        leads_by_status: list = []
        offset = 0
        while True:
            page = _rest_get("leads", params=f"?select=status&order=id.asc&limit=1000&offset={offset}")
            if isinstance(page, dict) and page.get("ok") is False:
                return f"Sir, I couldn't reach the pipeline: {page.get('error')}"
            if not isinstance(page, list):
                return f"Sir, pipeline_status got a non-list response from leads (offset={offset})."
            if not page:
                break
            leads_by_status.extend(page)
            if len(page) < 1000:
                break
            offset += len(page)
        counts: dict[str, int] = {}
        for row in leads_by_status:
            if not isinstance(row, dict):
                continue
            status = str(row.get("status") or "unknown")
            counts[status] = counts.get(status, 0) + 1
        total = sum(counts.values())

        jobs = _rest_get("browser_jobs", params="?select=status&order=id.asc&limit=1000")
        job_list = _as_list(jobs, "browser_jobs")
        if job_list is None and isinstance(jobs, dict) and jobs.get("ok") is False:
            return f"Sir, I couldn't reach the job queue: {jobs.get('error')}"
        # Page job statuses the same way as leads so pending counts are not capped at 1000.
        all_jobs: list = list(job_list or [])
        job_offset = len(all_jobs)
        while job_list and len(job_list) >= 1000:
            more = _rest_get(
                "browser_jobs",
                params=f"?select=status&order=id.asc&limit=1000&offset={job_offset}",
            )
            if not isinstance(more, list) or not more:
                break
            all_jobs.extend(more)
            if len(more) < 1000:
                break
            job_offset += len(more)
        pending_jobs = sum(1 for j in all_jobs if isinstance(j, dict) and j.get("status") == "pending")

        parts = ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda x: -x[1])[:5])
        armed = "ARMED (sends)" if is_pipeline_armed() else "dry-run (sends)"
        return (
            f"{total} leads in the pipeline (Supabase): {parts}. "
            f"{pending_jobs} browser jobs pending. Send mode: {armed}."
        )

    if action == "get_lead":
        query = parameters.get("query", "")
        rows = _rest_get(
            "leads",
            params=(
                f"?or=(email.ilike.*{query}*,property_name.ilike.*{query}*,"
                f"first_name.ilike.*{query}*,last_name.ilike.*{query}*)&limit=3"
            ),
        )
        if isinstance(rows, dict) and rows.get("ok") is False:
            return f"Sir, I couldn't search leads: {rows.get('error')}"
        lead_list = _as_list(rows, "leads")
        if not lead_list:
            return f"Sir, I couldn't find a lead matching '{query}'."
        lines = []
        for l in lead_list:
            if not isinstance(l, dict):
                continue
            lines.append(
                f"{l.get('first_name','')} {l.get('last_name','')} — "
                f"{l.get('property_name','')}, status {l.get('status')}, score {l.get('lead_score')}"
            )
        return "; ".join(lines) if lines else f"Sir, I couldn't find a lead matching '{query}'."

    if action == "job_status":
        rows = _rest_get("browser_jobs", params="?select=kind,status&order=created_at.desc&limit=10")
        if isinstance(rows, dict) and rows.get("ok") is False:
            return f"Sir, I couldn't reach the job queue: {rows.get('error')}"
        job_list = _as_list(rows, "browser_jobs")
        if job_list is None:
            return "Sir, I couldn't reach the job queue."
        if not job_list:
            return "No browser jobs in the queue right now."
        counts: dict[str, int] = {}
        for j in job_list:
            if not isinstance(j, dict):
                continue
            st = str(j.get("status") or "unknown")
            counts[st] = counts.get(st, 0) + 1
        return "Recent jobs: " + ", ".join(f"{v} {k}" for k, v in counts.items())

    if action == "worker_health":
        # Match worker getSession(): active + non-epoch refreshed_at.
        rows = _rest_get(
            "platform_sessions",
            params=(
                "?select=status,last_used_at,error_count,refreshed_at"
                "&platform=eq.airbnb&status=eq.active"
                "&refreshed_at=gt.2000-01-01T00:00:00.000Z"
                "&order=refreshed_at.desc&limit=1"
            ),
        )
        if isinstance(rows, dict) and rows.get("ok") is False:
            return f"Sir, I couldn't read platform_sessions: {rows.get('error')}"
        sess = _as_list(rows, "platform_sessions")
        if not sess:
            # Fall back: any non-epoch row so we report expired/stale truthfully.
            all_rows = _rest_get(
                "platform_sessions",
                params=(
                    "?select=status,last_used_at,error_count,refreshed_at"
                    "&platform=eq.airbnb"
                    "&refreshed_at=gt.2000-01-01T00:00:00.000Z"
                    "&order=refreshed_at.desc&limit=1"
                ),
            )
            sess = _as_list(all_rows, "platform_sessions") or []
            if not sess:
                return (
                    "Sir, I don't see any browser session for the worker — "
                    "queue session_refresh or run scripts/airbnb_cookie_push.py."
                )
            s = sess[0] if isinstance(sess[0], dict) else {}
            return (
                f"Worker session status: {s.get('status')} (no active non-epoch session), "
                f"{s.get('error_count', 0)} errors, last used {s.get('last_used_at')}, "
                f"refreshed {s.get('refreshed_at')}. Bootstrap cookies or queue session_refresh."
            )
        s = sess[0] if isinstance(sess[0], dict) else {}
        last_used = str(s.get("last_used_at") or "")
        if last_used.startswith("1970") or last_used.startswith("1969"):
            return (
                f"Worker session looks STALE (last_used epoch): status={s.get('status')}, "
                f"last used {s.get('last_used_at')}, refreshed {s.get('refreshed_at')}. "
                "Queue session_refresh or push cookies — Lightpanda will keep failing inbox_sync until then."
            )
        return (
            f"Worker session status: {s.get('status')}, {s.get('error_count', 0)} errors, "
            f"last used {s.get('last_used_at')}, refreshed {s.get('refreshed_at')}."
        )

    if action == "queue_job":
        kind = parameters.get("kind", "")
        if kind not in SAFE_JOB_KINDS and kind != "send_message":
            return f"Sir, I don't recognize job kind '{kind}'."
        import uuid
        job_id = f"bj_{uuid.uuid4().hex}"
        payload = dict(parameters.get("job_payload", {}) or {})

        if kind == "send_message":
            # Two gates: (1) pipeline must be ARMED via exact "GO FOR IT",
            # (2) this request must pass confirm_send. Otherwise always dry_run.
            armed = is_pipeline_armed()
            confirmed = bool(parameters.get("confirm_send"))
            payload["dry_run"] = not (armed and confirmed)
            if not payload.get("body") or not (payload.get("listing_id") or payload.get("thread_url")):
                return "Sir, I need a listing or thread and a message body to draft outreach."
            if confirmed and not armed:
                return (
                    "Sir, confirm_send was set but the pipeline is still DISARMED. "
                    "Say the exact phrase GO FOR IT first to arm live mode, then confirm again."
                )

        r = _rest_post("browser_jobs", body=[{
            "id": job_id, "kind": kind, "status": "pending", "priority": 5, "payload": payload,
        }])
        if isinstance(r, dict) and r.get("ok") is False:
            return f"Sir, I couldn't queue that job: {r.get('error')}"
        if not isinstance(r, list) and not (isinstance(r, dict) and r.get("id")):
            # Prefer return=representation → list; tolerate empty/opaque success.
            if isinstance(r, dict) and "error" in r:
                return f"Sir, I couldn't queue that job: {r.get('error')}"

        if kind == "send_message":
            if payload["dry_run"]:
                return (
                    "Drafted the outreach message — queued as a dry run, sir. "
                    "Say GO FOR IT to arm live mode, then confirm_send to actually send."
                )
            return "Outreach message queued and will be sent, sir."
        return f"Queued a {kind} job, sir."

    return f"Sir, I don't recognize the pipeline action '{action}'."

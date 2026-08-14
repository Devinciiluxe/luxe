"""Client for the `vbswmotdtyqakzuzkqui` Supabase project — the real ops
pipeline (5,000+ leads, browser_jobs worker on the VM, Airbnb outreach
automation). Note the separate project *named* "LUXE PIPELINE"
(dnnagfjwctjtrliftolb) is dead (RESTORE_FAILED) and holds none of this data.

JARVIS can read pipeline status/leads and queue the SAFE job kinds
(session_refresh, inbox_sync, scrape_listing) outright.

send_message is also queueable, but is NOT a safe kind: it sends a real
outbound message to a real person over Airbnb. It is guarded rather than
blocked — every send is written with dry_run=true (composes but does not
send) unless the caller passes confirm_send in the same request. Voice must
never reach a live send without that explicit confirmation, so a misheard or
hallucinated command lands as a draft, not an outbound DM.
"""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

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


def luxe_supabase(parameters: dict) -> str:
    if not SUPABASE_KEY:
        return "Sir, the pipeline Supabase key isn't configured."

    action = (parameters.get("action", "")).strip()

    if action == "pipeline_status":
        # PostgREST caps every response at 1000 rows, so "limit=1500" silently
        # returned 1000 of 5065 leads and reported that as the whole pipeline.
        # Page with offset until a short page comes back, so the count is the
        # real one.
        leads_by_status: list = []
        offset = 0
        while True:
            page = _rest("GET", "leads", params=f"?select=status&order=id.asc&limit=1000&offset={offset}")
            if isinstance(page, dict) and not page.get("ok", True):
                return f"Sir, I couldn't reach the pipeline: {page.get('error')}"
            if not isinstance(page, list) or not page:
                break
            leads_by_status.extend(page)
            if len(page) < 1000:
                break
            offset += len(page)
        counts: dict[str, int] = {}
        for row in leads_by_status:
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        total = sum(counts.values())

        jobs = _rest("GET", "browser_jobs", params="?select=status")
        pending_jobs = sum(1 for j in jobs if isinstance(j, dict) and j.get("status") == "pending") if isinstance(jobs, list) else 0

        parts = ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda x: -x[1])[:5])
        return f"{total} leads in the pipeline: {parts}. {pending_jobs} browser jobs pending."

    if action == "get_lead":
        query = parameters.get("query", "")
        rows = _rest("GET", "leads", params=f"?or=(email.ilike.*{query}*,property_name.ilike.*{query}*,first_name.ilike.*{query}*,last_name.ilike.*{query}*)&limit=3")
        if not isinstance(rows, list) or not rows:
            return f"Sir, I couldn't find a lead matching '{query}'."
        lines = []
        for l in rows:
            lines.append(f"{l.get('first_name','')} {l.get('last_name','')} — {l.get('property_name','')}, status {l.get('status')}, score {l.get('lead_score')}")
        return "; ".join(lines)

    if action == "job_status":
        rows = _rest("GET", "browser_jobs", params="?select=kind,status&order=created_at.desc&limit=10")
        if not isinstance(rows, list):
            return "Sir, I couldn't reach the job queue."
        if not rows:
            return "No browser jobs in the queue right now."
        counts: dict[str, int] = {}
        for j in rows:
            counts[j["status"]] = counts.get(j["status"], 0) + 1
        return "Recent jobs: " + ", ".join(f"{v} {k}" for k, v in counts.items())

    if action == "worker_health":
        rows = _rest("GET", "platform_sessions", params="?select=status,last_used_at,error_count&order=last_used_at.desc&limit=1")
        if not isinstance(rows, list) or not rows:
            return "Sir, I don't see any active browser session for the worker."
        s = rows[0]
        return f"Worker session status: {s.get('status')}, {s.get('error_count', 0)} errors, last used {s.get('last_used_at')}."

    if action == "queue_job":
        kind = parameters.get("kind", "")
        if kind not in SAFE_JOB_KINDS and kind != "send_message":
            return f"Sir, I don't recognize job kind '{kind}'."
        import uuid
        job_id = f"bj_{uuid.uuid4().hex}"
        payload = dict(parameters.get("job_payload", {}) or {})

        if kind == "send_message":
            # Outbound outreach — real message to a real lead. Defaults to
            # dry_run (composes but doesn't send) unless the caller explicitly
            # confirms a live send in this same request.
            confirmed = bool(parameters.get("confirm_send"))
            payload["dry_run"] = not confirmed
            if not payload.get("body") or not (payload.get("listing_id") or payload.get("thread_url")):
                return "Sir, I need a listing or thread and a message body to draft outreach."

        r = _rest("POST", "browser_jobs", body=[{
            "id": job_id, "kind": kind, "status": "pending", "priority": 5, "payload": payload,
        }])
        if isinstance(r, dict) and not r.get("ok", True):
            return f"Sir, I couldn't queue that job: {r.get('error')}"

        if kind == "send_message":
            if payload["dry_run"]:
                return "Drafted the outreach message — it's queued as a dry run, sir. Say 'confirm send' to actually send it."
            return "Outreach message queued and will be sent, sir."
        return f"Queued a {kind} job, sir."

    return f"Sir, I don't recognize the pipeline action '{action}'."

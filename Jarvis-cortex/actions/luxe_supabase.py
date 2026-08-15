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
import threading
import time
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


# ── Progressive snapshot cache ───────────────────────────────────────────────
# A voice turn must never wait on PostgREST. A background thread refreshes a
# local snapshot every _REFRESH_SECS; read actions answer from it instantly.
# A stale snapshot is still served (with its age spoken) while a refresh runs
# behind it — a slightly old number now beats a fresh one after seconds of
# dead air. Writes (queue_job, arming) always hit Supabase live.

_REFRESH_SECS = 30.0

_cache_lock        = threading.Lock()
_cache: dict       = {}                  # key -> (monotonic_ts, data)
_refresh_now       = threading.Event()
_refresher_started = False


def _cache_get(key: str) -> "tuple[float | None, object | None]":
    with _cache_lock:
        entry = _cache.get(key)
    if not entry:
        return None, None
    ts, data = entry
    return time.monotonic() - ts, data


def _cache_put(key: str, data) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic(), data)


def _age_note(age: "float | None") -> str:
    if age is None or age < 45:
        return ""
    if age < 120:
        return " Snapshot about a minute old — refreshing behind the scenes."
    return f" Snapshot {int(age // 60)} minutes old — refreshing behind the scenes."


def _fetch_leads_counts() -> "dict | None":
    """Page the full leads table (PostgREST caps at 1000/page) → status counts."""
    counts: dict = {}
    offset = 0
    while True:
        page = _rest_get("leads", params=f"?select=status&order=id.asc&limit=1000&offset={offset}")
        if not isinstance(page, list):
            return None
        for row in page:
            if isinstance(row, dict):
                status = str(row.get("status") or "unknown")
                counts[status] = counts.get(status, 0) + 1
        if len(page) < 1000:
            break
        offset += len(page)
    return counts


def _fetch_jobs() -> "dict | None":
    """Latest 50 jobs (rendering) + full paged status scan (pending count)."""
    recent = _rest_get(
        "browser_jobs",
        params=(
            "?select=id,kind,status,error,created_at,done_at,claimed_at"
            "&order=created_at.desc&limit=50"
        ),
    )
    recent_list = _as_list(recent, "browser_jobs")
    if recent_list is None:
        return None
    statuses: list = []
    offset = 0
    while True:
        page = _rest_get("browser_jobs", params=f"?select=status&order=id.asc&limit=1000&offset={offset}")
        if not isinstance(page, list):
            break
        statuses.extend(page)
        if len(page) < 1000:
            break
        offset += len(page)
    pending = sum(1 for j in statuses if isinstance(j, dict) and j.get("status") == "pending")
    return {"recent": recent_list, "pending": pending}


def _fetch_worker() -> "dict | None":
    """Active airbnb session row (worker getSession() match) + stale fallback row."""
    rows = _rest_get(
        "platform_sessions",
        params=(
            "?select=status,last_used_at,error_count,refreshed_at"
            "&platform=eq.airbnb&status=eq.active"
            "&refreshed_at=gt.2000-01-01T00:00:00.000Z"
            "&order=refreshed_at.desc&limit=1"
        ),
    )
    active = _as_list(rows, "platform_sessions")
    if active is None and isinstance(rows, dict) and rows.get("ok") is False:
        return None
    fallback: list = []
    if not active:
        all_rows = _rest_get(
            "platform_sessions",
            params=(
                "?select=status,last_used_at,error_count,refreshed_at"
                "&platform=eq.airbnb"
                "&refreshed_at=gt.2000-01-01T00:00:00.000Z"
                "&order=refreshed_at.desc&limit=1"
            ),
        )
        fallback = _as_list(all_rows, "platform_sessions") or []
    return {"active": active or [], "fallback": fallback}


_FETCHERS = (
    ("leads_counts", _fetch_leads_counts),
    ("jobs",         _fetch_jobs),
    ("worker",       _fetch_worker),
)


def _refresher_loop() -> None:
    while True:
        for key, fn in _FETCHERS:
            try:
                data = fn()
                if data is not None:
                    _cache_put(key, data)
            except Exception:
                pass                      # keep serving the last good snapshot
        _refresh_now.wait(timeout=_REFRESH_SECS)
        _refresh_now.clear()


def start_cache() -> None:
    """Start the background snapshot refresher (idempotent, daemon)."""
    global _refresher_started
    if not SUPABASE_KEY:
        return
    with _cache_lock:
        if _refresher_started:
            return
        _refresher_started = True
    threading.Thread(target=_refresher_loop, daemon=True, name="luxe-snapshot").start()


def _snapshot(key: str, fetch) -> "tuple[object | None, str]":
    """Cached data + spoken age note. Cold cache → one inline live fetch."""
    start_cache()
    age, data = _cache_get(key)
    if data is None:
        data = fetch()                    # first call ever (or network was down)
        if data is not None:
            _cache_put(key, data)
        return data, ""
    if age is not None and age > _REFRESH_SECS:
        _refresh_now.set()
    return data, _age_note(age)


# get_lead is parameterized, so it can't be pre-fetched — a small per-query
# TTL cache still makes repeat asks ("what about that lead again?") instant.
_LEAD_TTL = 60.0
_lead_cache: "dict[str, tuple[float, str]]" = {}


def luxe_supabase(parameters: dict) -> str:
    if not SUPABASE_KEY:
        return "Sir, the pipeline Supabase key isn't configured."

    start_cache()
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
        # Queue snapshot for Jarvis to narrate the claim→process→status cycle.
        limit = int(parameters.get("limit") or 15)
        limit = max(1, min(limit, 50))
        jobs, note = _snapshot("jobs", _fetch_jobs)
        if jobs is None or not isinstance(jobs, dict):
            return "Sir, I couldn't watch the job queue."
        job_list = list(jobs.get("recent") or [])[:limit]
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
        return f"Watching queue ({summary}). Latest: " + "; ".join(lines[:8]) + note

    if action == "pipeline_status":
        # Full-table paging lives in _fetch_leads_counts and runs on the
        # background refresher — this handler answers from the snapshot so the
        # voice never waits through six serial PostgREST round-trips.
        counts, note = _snapshot("leads_counts", _fetch_leads_counts)
        if not isinstance(counts, dict):
            return "Sir, I couldn't reach the pipeline just now — I'll have fresh numbers on the next pass."
        total = sum(counts.values())

        jobs, jnote = _snapshot("jobs", _fetch_jobs)
        pending_jobs = jobs.get("pending", 0) if isinstance(jobs, dict) else 0

        parts = ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda x: -x[1])[:5])
        armed = "ARMED (sends)" if is_pipeline_armed() else "dry-run (sends)"
        return (
            f"{total} leads in the pipeline (Supabase): {parts}. "
            f"{pending_jobs} browser jobs pending. Send mode: {armed}." + (note or jnote)
        )

    if action == "get_lead":
        query = parameters.get("query", "")
        hit = _lead_cache.get(query)
        if hit and time.monotonic() - hit[0] < _LEAD_TTL:
            return hit[1]
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
            result = f"Sir, I couldn't find a lead matching '{query}'."
        else:
            lines = []
            for l in lead_list:
                if not isinstance(l, dict):
                    continue
                lines.append(
                    f"{l.get('first_name','')} {l.get('last_name','')} — "
                    f"{l.get('property_name','')}, status {l.get('status')}, score {l.get('lead_score')}"
                )
            result = "; ".join(lines) if lines else f"Sir, I couldn't find a lead matching '{query}'."
        if len(_lead_cache) >= 32:
            _lead_cache.pop(next(iter(_lead_cache)))
        _lead_cache[query] = (time.monotonic(), result)
        return result

    if action == "job_status":
        jobs, note = _snapshot("jobs", _fetch_jobs)
        if jobs is None or not isinstance(jobs, dict):
            return "Sir, I couldn't reach the job queue."
        job_list = list(jobs.get("recent") or [])[:10]
        if not job_list:
            return "No browser jobs in the queue right now."
        counts: dict[str, int] = {}
        for j in job_list:
            if not isinstance(j, dict):
                continue
            st = str(j.get("status") or "unknown")
            counts[st] = counts.get(st, 0) + 1
        return "Recent jobs: " + ", ".join(f"{v} {k}" for k, v in counts.items()) + note

    if action == "worker_health":
        # Match worker getSession(): active + non-epoch refreshed_at.
        # Fetch logic lives in _fetch_worker; this handler reads the snapshot.
        data, note = _snapshot("worker", _fetch_worker)
        if not isinstance(data, dict):
            return "Sir, I couldn't read platform_sessions."
        sess = data.get("active") or []
        if not sess:
            # Fall back: any non-epoch row so we report expired/stale truthfully.
            sess = data.get("fallback") or []
            if not sess:
                return (
                    "Sir, I don't see any browser session for the worker — "
                    "queue session_refresh or run scripts/airbnb_cookie_push.py."
                )
            s = sess[0] if isinstance(sess[0], dict) else {}
            return (
                f"Worker session status: {s.get('status')} (no active non-epoch session), "
                f"{s.get('error_count', 0)} errors, last used {s.get('last_used_at')}, "
                f"refreshed {s.get('refreshed_at')}. Bootstrap cookies or queue session_refresh." + note
            )
        s = sess[0] if isinstance(sess[0], dict) else {}
        last_used = str(s.get("last_used_at") or "")
        if last_used.startswith("1970") or last_used.startswith("1969"):
            return (
                f"Worker session looks STALE (last_used epoch): status={s.get('status')}, "
                f"last used {s.get('last_used_at')}, refreshed {s.get('refreshed_at')}. "
                "Queue session_refresh or push cookies — Lightpanda will keep failing inbox_sync until then." + note
            )
        return (
            f"Worker session status: {s.get('status')}, {s.get('error_count', 0)} errors, "
            f"last used {s.get('last_used_at')}, refreshed {s.get('refreshed_at')}." + note
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
            # Persist confirm_send on the job so the VM worker can re-check it
            # (worker must not trust dry_run=false alone).
            # Send gate always checks live — never the status-display cache.
            armed = is_pipeline_armed(fresh=True)
            confirmed = bool(parameters.get("confirm_send"))
            payload["confirm_send"] = confirmed
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

        # Reflect the new job in the snapshot immediately (so a follow-up
        # "watch the queue" sees it) and pull a real refresh behind it.
        try:
            _, jobs = _cache_get("jobs")
            if isinstance(jobs, dict):
                _cache_put("jobs", {
                    "recent": [{
                        "id": job_id, "kind": kind, "status": "pending",
                        "error": None, "created_at": None, "done_at": None,
                        "claimed_at": None,
                    }] + list(jobs.get("recent") or [])[:49],
                    "pending": int(jobs.get("pending", 0)) + 1,
                })
        except Exception:
            pass
        _refresh_now.set()

        if kind == "send_message":
            if payload["dry_run"]:
                return (
                    "Drafted the outreach message — queued as a dry run, sir. "
                    "Say GO FOR IT to arm live mode, then confirm_send to actually send."
                )
            return "Outreach message queued and will be sent, sir."
        return f"Queued a {kind} job, sir."

    return f"Sir, I don't recognize the pipeline action '{action}'."

"""Client for the LUXE CORTEX sales pipeline REST API (/api/jarvis on the
luxe-cortex dashboard, localhost:8787). Lets JARVIS read leads/metrics and
drive pipeline actions (stage moves, hunter sweeps, proposals, bookings)."""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "api_keys.json"


def _load_cfg() -> dict:
    if not _CFG_PATH.is_file():
        return {}
    return json.loads(_CFG_PATH.read_text())


_cfg = _load_cfg()

BASE_URL = os.environ.get("LUXE_CORTEX_URL", "") or _cfg.get("luxe_cortex_url", "http://localhost:8787")

# No hardcoded fallback key. An unset key is reported to the caller by
# luxe_pipeline() before any request is attempted, so a missing credential
# surfaces as a spoken error rather than a silent failed call.
API_KEY = os.environ.get("JARVIS_API_KEY", "") or _cfg.get("jarvis_api_key", "")


def _send(req: "urllib.request.Request") -> dict:
    req.add_header("Authorization", f"Bearer {API_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"ok": False, "error": f"HTTP {e.code} {e.reason}: {raw[:200]}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"cannot reach {BASE_URL}: {e.reason}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _request_get(path: str) -> dict:
    return _send(urllib.request.Request(f"{BASE_URL}{path}", method="GET"))


def _request_post(path: str, body: dict) -> dict:
    req = urllib.request.Request(f"{BASE_URL}{path}", data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    return _send(req)


def luxe_pipeline(parameters: dict) -> str:
    if not API_KEY:
        return (
            "Sir, the luxe-cortex API key isn't configured. Set JARVIS_API_KEY in the "
            "environment or jarvis_api_key in config/api_keys.json."
        )

    action = (parameters.get("action", "")).strip()

    if action == "snapshot":
        r = _request_get("/api/jarvis")
        if not r.get("ok"):
            return f"Sir, I couldn't reach the pipeline: {r.get('error', 'unknown error')}"
        m = r["metrics"]
        return (
            f"{len(r['leads'])} leads in the pipeline, worth ${m['pipelineCents']/100:,.0f}. "
            f"{m['pendingReplies']} pending replies, {m['pendingOutreach']} pending outreach, "
            f"{m['won']} won, {m['noShows']} no-shows. Reply rate {m['replyRate']*100:.0f}%."
        )

    if action == "get_lead":
        lead_id = parameters.get("lead_id", "")
        r = _request_get(f"/api/jarvis?leadId={lead_id}")
        if not r.get("ok"):
            return f"Sir, I couldn't find that lead: {r.get('error', 'unknown error')}"
        l = r["lead"]
        return f"{l['name']} at {l['company']}, stage {l['stage']}, score {l['score']}, value ${l['value']/100:,.0f}."

    if action == "set_stage":
        r = _request_post("/api/jarvis", {
            "action": "set_stage",
            "leadId": parameters.get("lead_id", ""),
            "stage": parameters.get("stage", ""),
        })
        if not r.get("ok"):
            return f"Sir, I couldn't move that lead: {r.get('error', 'unknown error')}"
        return f"Moved to {parameters.get('stage', '')}, sir."

    if action == "run_hunter":
        # Disabled deliberately. createScrapedLead() (db.server.ts:519) invents a
        # lead — random name, random company from two word lists, value =
        # Math.random()*420k, random score — and INSERTs it into the local D1
        # `leads` table. allLeads() reads Supabase, never D1, so the lead never
        # reaches the pipeline; it is only ever returned here and spoken aloud as
        # if it were real. Re-enable only when backed by an actual scraper.
        return (
            "Sir, run_hunter is disabled. It fabricated leads with a random number "
            "generator and wrote them where nothing reads them. Real leads come from "
            "the scrape_listing worker jobs."
        )

    if action == "toggle_automation":
        r = _request_post("/api/jarvis", {
            "action": "toggle_automation",
            "which": parameters.get("which", ""),
            "on": parameters.get("on", True),
        })
        if not r.get("ok"):
            return f"Sir, I couldn't toggle that: {r.get('error', 'unknown error')}"
        state = "on" if parameters.get("on", True) else "off"
        return f"{parameters.get('which', '')} automation is now {state}, sir."

    if action == "make_proposal":
        r = _request_post("/api/jarvis", {"action": "make_proposal", "leadId": parameters.get("lead_id", "")})
        if not r.get("ok"):
            return f"Sir, I couldn't stage that proposal: {r.get('error', 'unknown error')}"
        return f"Proposal staged: {r['doc']['title']}."

    if action == "mark_no_show":
        r = _request_post("/api/jarvis", {"action": "mark_no_show", "leadId": parameters.get("lead_id", "")})
        if not r.get("ok"):
            return f"Sir, that failed: {r.get('error', 'unknown error')}"
        return "Marked as no-show, rescue sequence queued."

    return f"Sir, I don't recognize the pipeline action '{action}'."

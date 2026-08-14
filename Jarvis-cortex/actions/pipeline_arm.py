"""Pipeline live-mode arming gate.

Dry-run stays ON for all Airbnb send_message jobs until the operator says the
exact phrase "GO FOR IT". That phrase arms LIVE SENDS only.

Pipeline STATS (lead counts, job queue, worker health) always come from
Supabase PostgREST via luxe_supabase — they do NOT require arming and must
never be described as "demo" or gated behind GO FOR IT.

Arm state is written locally (config/pipeline_live.armed) AND mirrored into
Supabase settings key `pipeline_live` so the VM worker sees the same gate
without copying env files.

Even when armed, queue_job(send_message) still requires confirm_send=true —
arming is the master switch; confirm_send is the per-message safety.

Case rules:
  - Tool/API `phrase=` must be exactly "GO FOR IT" (case-sensitive) so the
    model cannot invent a lowercase substitute.
  - Spoken utterances match the three words case-insensitively (STT almost
    never preserves ALL-CAPS) via utterance_contains_arm_phrase().
  TODO(operator): if spoken arming must also require ALL-CAPS exactly as typed,
  tighten utterance_contains_arm_phrase() — default below tolerates STT casing
  so voice unlock stays usable.

Ops: say "GO FOR IT" to Jarvis, or call arm_live with phrase="GO FOR IT".
Optional VM override: LUXE_PIPELINE_LIVE=1 (rare — prefer the phrase gate).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

# Exact phrase for API `phrase=` — case-sensitive. Do not soften that check.
ARM_PHRASE = "GO FOR IT"
SETTINGS_KEY = "pipeline_live"

_STATE_PATH = Path(__file__).resolve().parent.parent / "config" / "pipeline_live.armed"
_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "api_keys.json"


def _supabase_creds() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if url and key:
        return url.rstrip("/"), key
    try:
        cfg = json.loads(_CFG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return "", ""
    return (
        str(cfg.get("luxe_supabase_url") or "https://vbswmotdtyqakzuzkqui.supabase.co").rstrip("/"),
        str(cfg.get("luxe_supabase_service_key") or ""),
    )


def _mirror_settings(armed: bool) -> None:
    """Best-effort mirror so worker/Lightpanda VM shares the same live gate."""
    url, key = _supabase_creds()
    if not key:
        return
    body = {
        "key": SETTINGS_KEY,
        "value": json.dumps({"armed": armed, "phrase": ARM_PHRASE if armed else ""}),
        "updated_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
    }
    req = urllib.request.Request(
        f"{url}/rest/v1/settings",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        pass


def _settings_armed() -> bool | None:
    """None = unknown / unreachable; True/False when settings row exists."""
    url, key = _supabase_creds()
    if not key:
        return None
    req = urllib.request.Request(
        f"{url}/rest/v1/settings?key=eq.{SETTINGS_KEY}&select=value&limit=1",
        method="GET",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode()
            rows = json.loads(raw) if raw else []
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(rows, list) or not rows:
        return None
    val = rows[0].get("value") if isinstance(rows[0], dict) else None
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except json.JSONDecodeError:
            return val.strip() in ("1", "true", "TRUE")
    if isinstance(val, dict):
        return bool(val.get("armed"))
    if isinstance(val, bool):
        return val
    return None


def is_pipeline_armed() -> bool:
    """True only when live mode has been explicitly armed."""
    env = os.environ.get("LUXE_PIPELINE_LIVE", "").strip()
    if env in ("1", "true", "TRUE", "yes", "YES"):
        return True
    if env in ("0", "false", "FALSE", "no", "NO"):
        return False
    try:
        if _STATE_PATH.is_file() and _STATE_PATH.read_text(encoding="utf-8").strip() == "1":
            return True
    except OSError:
        pass
    remote = _settings_armed()
    return bool(remote)


def arm_pipeline() -> None:
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text("1\n", encoding="utf-8")
    _mirror_settings(True)


def disarm_pipeline() -> None:
    try:
        if _STATE_PATH.is_file():
            _STATE_PATH.unlink()
    except OSError:
        pass
    _mirror_settings(False)


def utterance_contains_arm_phrase(text: str) -> bool:
    """Spoken path: three contiguous words 'go for it' (STT case-tolerant)."""
    if not text:
        return False
    if ARM_PHRASE in text:
        return True
    lowered = " ".join(text.lower().split())
    return "go for it" in lowered


def arm_from_phrase(phrase: str) -> bool:
    """Arm from tool `phrase=` — requires exact ARM_PHRASE (case-sensitive).

    Models must pass phrase exactly equal to GO FOR IT. Spoken STT arming
    goes through utterance_contains_arm_phrase + arm_pipeline in the session
    loop, not this function.
    """
    if phrase == ARM_PHRASE:
        arm_pipeline()
        return True
    return False

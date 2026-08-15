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
import time
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


# The remote settings lookup is a network round-trip; status displays call
# is_pipeline_armed() inside the voice path, so cache the remote answer
# briefly. Arm/disarm invalidates it, and the send gate passes fresh=True —
# safety decisions never ride the cache.
_REMOTE_TTL = 15.0
_remote_cache: "tuple[float, bool | None] | None" = None


def _settings_armed_cached() -> "bool | None":
    global _remote_cache
    now = time.monotonic()
    if _remote_cache is not None and now - _remote_cache[0] < _REMOTE_TTL:
        return _remote_cache[1]
    val = _settings_armed()
    _remote_cache = (now, val)
    return val


def _invalidate_remote_cache() -> None:
    global _remote_cache
    _remote_cache = None


def is_pipeline_armed(fresh: bool = False) -> bool:
    """True only when live mode has been explicitly armed.

    fresh=True forces a live remote lookup (used by the send gate);
    the default serves status displays from a 15 s cache.
    """
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
    remote = _settings_armed() if fresh else _settings_armed_cached()
    if fresh:
        _remote_cache_update(remote)
    return bool(remote)


def _remote_cache_update(val: "bool | None") -> None:
    global _remote_cache
    _remote_cache = (time.monotonic(), val)


def arm_pipeline() -> None:
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text("1\n", encoding="utf-8")
    _invalidate_remote_cache()
    _mirror_settings(True)


def disarm_pipeline() -> None:
    try:
        if _STATE_PATH.is_file():
            _STATE_PATH.unlink()
    except OSError:
        pass
    _invalidate_remote_cache()
    _mirror_settings(False)


def utterance_contains_arm_phrase(text: str) -> bool:
    """Spoken path: standalone 'go for it' (STT case-tolerant).

    Rejects negation / embedding ("don't go for it", "should we go for it?").
    Exact ARM_PHRASE substring still matches for typed ALL-CAPS.
    """
    if not text:
        return False
    if text.strip() == ARM_PHRASE or text.strip().upper() == ARM_PHRASE:
        return True
    import re

    lowered = " ".join(text.lower().split())
    # Leading negation: don't / do not / never / not going to …
    if re.search(r"\b(don'?t|do not|never|not)\b.{0,24}\bgo\s+for\s+it\b", lowered):
        return False
    # Interrogative / hedging: should we / maybe / if we …
    if re.search(r"\b(should|could|would|maybe|might|if)\b.{0,24}\bgo\s+for\s+it\b", lowered):
        return False
    # Whole utterance is essentially just the three words (optional punctuation).
    if re.fullmatch(r"go\s+for\s+it[.!?]?", lowered):
        return True
    # Or the three words as their own sentence clause.
    return bool(re.search(r"(?:^|[.!?]\s+)go\s+for\s+it(?:[.!?]|$)", lowered))


def arm_from_phrase(phrase: str) -> bool:
    """Arm from tool `phrase=` — requires exact ARM_PHRASE (case-sensitive).

    Models must pass phrase exactly equal to GO FOR IT. Spoken STT arming
    goes through utterance_contains_arm_phrase + arm_pipeline in the session
    loop, not this function.
    """
    # #region agent log
    try:
        import time as _t
        _p = Path("/Users/devinci/luxe-mstr-rebuild/.cursor/debug-78349c.log")
        _exact = phrase == ARM_PHRASE
        _p.parent.mkdir(parents=True, exist_ok=True)
        with _p.open("a", encoding="utf-8") as _f:
            _f.write(json.dumps({
                "sessionId": "78349c",
                "runId": "arm-go-for-it",
                "hypothesisId": "H1",
                "location": "pipeline_arm.py:arm_from_phrase",
                "message": "arm_from_phrase invoked",
                "data": {
                    "phrase_len": len(phrase or ""),
                    "exact_match": _exact,
                    "contains_lower": "go for it" in " ".join((phrase or "").lower().split()),
                },
                "timestamp": int(_t.time() * 1000),
            }) + "\n")
    except Exception:
        pass
    # #endregion
    if phrase == ARM_PHRASE:
        arm_pipeline()
        # #region agent log
        try:
            import time as _t
            _armed = is_pipeline_armed()
            _p = Path("/Users/devinci/luxe-mstr-rebuild/.cursor/debug-78349c.log")
            with _p.open("a", encoding="utf-8") as _f:
                _f.write(json.dumps({
                    "sessionId": "78349c",
                    "runId": "arm-go-for-it",
                    "hypothesisId": "H2",
                    "location": "pipeline_arm.py:arm_from_phrase:after",
                    "message": "arm_pipeline completed",
                    "data": {
                        "local_armed_file": _STATE_PATH.is_file(),
                        "is_pipeline_armed": _armed,
                        "settings_armed": _settings_armed(),
                    },
                    "timestamp": int(_t.time() * 1000),
                }) + "\n")
        except Exception:
            pass
        # #endregion
        return True
    return False

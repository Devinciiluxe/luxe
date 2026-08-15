#!/usr/bin/env python3
"""
Export Airbnb cookies from your local Chrome profile and push them into the
LUXE platform_sessions table so the VM worker can use your login.

Usage:  python3 scripts/airbnb_cookie_push.py
Requires: pip install pycryptodome. Prefers a copy of Chrome's Cookies DB
(works while Chrome is open on macOS); falls back to a direct open if needed.

Ops notes (no secrets in chat):
  - SUPABASE_SERVICE_KEY must already be in the environment (never paste into logs).
  - Prefer this OR queue a session_refresh job — agents must not dump cookies/JWT.
  - After a successful push, epoch rows are marked expired (same as worker saveSession).
  - airbnb.ca and airbnb.com are separate login surfaces: _jwt is host-scoped and
    not interchangeable. Capture from whichever TLD Chrome is actually logged into;
    the worker navigates that same TLD on restore (see worker airbnbSiteFromCookies).
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

SUPABASE_REST = os.environ.get(
    "SUPABASE_URL", "https://vbswmotdtyqakzuzkqui.supabase.co"
).rstrip("/") + "/rest/v1"
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SESSION_EPOCH_CUTOFF = "2000-01-01T00:00:00.000Z"

CHROME_COOKIES = os.path.expanduser(
    "~/Library/Application Support/Google/Chrome/Default/Cookies"
)

# Auth-bearing cookie names we prefer to see alongside _jwt (presence only logged).
AUTHISH = ("_jwt", "_airbed_session_id", "hli", "li", "_user_attributes")


def decrypt_chrome_mac(encrypted: bytes) -> str:
    # Chrome on macOS stores the key in Keychain; v10 prefix = AES-128-CBC PBKDF2.
    if encrypted[:3] != b"v10":
        return ""
    try:
        import subprocess

        from Crypto.Cipher import AES
        from Crypto.Protocol.KDF import PBKDF2

        password = subprocess.check_output(
            ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"]
        ).strip()
        key = PBKDF2(password, b"saltysalt", 16, count=1003)
        iv = b" " * 16
        plain = AES.new(key, AES.MODE_CBC, iv).decrypt(encrypted[3:])
        pad = plain[-1]
        return plain[:-pad].decode("utf-8", "ignore")
    except Exception:
        return ""


def _rest(method: str, path: str, body=None, params: str = "") -> None:
    url = f"{SUPABASE_REST}/{path}{params}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=minimal")
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def _tld_of(domain: str) -> str:
    d = (domain or "").lower().lstrip(".")
    if d.endswith("airbnb.ca") or ".airbnb.ca" in d:
        return "ca"
    if d.endswith("airbnb.com") or ".airbnb.com" in d:
        return "com"
    return "other"


def _open_cookie_db(path: str) -> tuple[sqlite3.Connection, str | None]:
    """Copy-then-open so Chrome can stay running (DB is often locked in place).
    Returns (connection, temp_path_or_None). Caller deletes temp_path when set."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    try:
        shutil.copy(path, tmp.name)
        return sqlite3.connect(tmp.name), tmp.name
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        # Last resort: open in place (needs Chrome closed / unlocked).
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True), None


def main() -> None:
    if not SERVICE_KEY:
        sys.exit("set SUPABASE_SERVICE_KEY first")
    if not os.path.exists(CHROME_COOKIES):
        sys.exit(f"Chrome cookie DB not found at {CHROME_COOKIES} — using another browser?")

    con, tmp_path = _open_cookie_db(CHROME_COOKIES)
    try:
        rows = con.execute(
            "select name, value, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly "
            "from cookies where host_key like '%airbnb%'"
        ).fetchall()
    finally:
        con.close()
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    cookies = []
    host_names: dict[str, set[str]] = defaultdict(set)
    for name, value, enc, host, path, exp, sec, http in rows:
        v = value or decrypt_chrome_mac(enc)
        if not v:
            continue
        host_names[host].add(name)
        cookies.append({
            "name": name,
            "value": v,
            "domain": host,
            "path": path,
            # Chrome epoch is 1601-01-01, unix is 1970:
            "expires": (exp / 1_000_000 - 11644473600) if exp else None,
            "secure": bool(sec),
            "httpOnly": bool(http),
        })

    if not cookies:
        sys.exit(
            "no airbnb cookies found — log into www.airbnb.com or www.airbnb.ca in Chrome, then re-run"
        )

    # Prefer the TLD that actually holds _jwt (ca and com are not interchangeable).
    jwt_cookie = next((c for c in cookies if c["name"] == "_jwt"), None)
    if jwt_cookie:
        jwt_tld = _tld_of(str(jwt_cookie["domain"]))
        # Keep cookies for that TLD first, then any other airbnb hosts (cdn, etc.).
        preferred = [c for c in cookies if _tld_of(str(c["domain"])) == jwt_tld]
        other = [c for c in cookies if _tld_of(str(c["domain"])) != jwt_tld]
        cookies = preferred + other
        jwt = jwt_cookie["value"]
        site = f"airbnb.{jwt_tld}" if jwt_tld in ("ca", "com") else str(jwt_cookie["domain"])
    else:
        jwt = ""
        hosts_summary = ", ".join(
            f"{h}[{','.join(sorted(n for n in names if n in AUTHISH) or ['(no authish)'])}]"
            for h, names in sorted(host_names.items())
        )
        sys.exit(
            "no _jwt in Chrome Airbnb cookies — not a usable host session. "
            f"hosts={hosts_summary}. "
            "Log into www.airbnb.com (or .ca) in Chrome until account pages work, then re-run. "
            "(CA vs COM accounts differ; worker follows the TLD that has _jwt.)"
        )

    now = datetime.now(timezone.utc).isoformat()
    # Retire epoch / never-refreshed rows so they cannot shadow this push.
    try:
        _rest(
            "PATCH",
            "platform_sessions",
            body={"status": "expired", "last_error": "superseded by airbnb_cookie_push"},
            params=f"?platform=eq.airbnb&refreshed_at=lte.{SESSION_EPOCH_CUTOFF}",
        )
    except urllib.error.HTTPError as e:
        print(f"warn: could not expire epoch rows: HTTP {e.code}", file=sys.stderr)

    body = {
        "platform": "airbnb",
        "status": "active",
        "lightpanda_url": "ws://127.0.0.1:9222",
        "cookies_json": cookies,
        "jwt": jwt,
        "user_agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ),
        "proxy_url": "",
        "fingerprint": {},
        "refreshed_at": now,
        "last_used_at": now,
        "expires_at": "",
        "last_error": "",
        "error_count": 0,
    }
    try:
        _rest("POST", "platform_sessions", body=body)
        print(
            f"uploaded {len(cookies)} cookies, jwt=yes, site={site} "
            "(secrets not printed; worker will navigate this TLD)"
        )
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

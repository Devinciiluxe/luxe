#!/usr/bin/env python3
"""
Export Airbnb cookies from your local Chrome profile and push them into the
LUXE platform_sessions table so the VM worker can use your login.

Usage:  python3 airbnb_cookie_push.py
Requires: Chrome closed (it locks the cookie DB), and pip install pycryptodome
"""
import os, sys, json, sqlite3, shutil, tempfile, base64, urllib.request
from datetime import datetime, timezone

SUPABASE_URL = "https://vbswmotdtyqakzuzkqui.supabase.co/rest/v1/platform_sessions"
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

CHROME_COOKIES = os.path.expanduser(
    "~/Library/Application Support/Google/Chrome/Default/Cookies")

def decrypt_chrome_mac(encrypted: bytes) -> str:
    # Chrome on macOS stores the key in Keychain; v10 prefix = AES-128-CBC PBKDF2.
    if not encrypted[:3] == b"v10":
        return ""
    try:
        from Crypto.Cipher import AES
        from Crypto.Protocol.KDF import PBKDF2
        import subprocess
        password = subprocess.check_output(
            ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"]).strip()
        key = PBKDF2(password, b"saltysalt", 16, count=1003)
        iv = b" " * 16
        plain = AES.new(key, AES.MODE_CBC, iv).decrypt(encrypted[3:])
        pad = plain[-1]
        return plain[:-pad].decode("utf-8", "ignore")
    except Exception:
        return ""

def main():
    if not SERVICE_KEY:
        sys.exit("set SUPABASE_SERVICE_KEY first")
    if not os.path.exists(CHROME_COOKIES):
        sys.exit(f"Chrome cookie DB not found at {CHROME_COOKIES} — using another browser?")

    tmp = tempfile.mktemp(suffix=".db")
    shutil.copy(CHROME_COOKIES, tmp)
    con = sqlite3.connect(tmp)
    rows = con.execute(
        "select name, value, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly "
        "from cookies where host_key like '%airbnb%'").fetchall()
    con.close(); os.unlink(tmp)

    cookies = []
    for name, value, enc, host, path, exp, sec, http in rows:
        v = value or decrypt_chrome_mac(enc)
        if not v:
            continue
        cookies.append({
            "name": name, "value": v, "domain": host, "path": path,
            # Chrome epoch is 1601-01-01, unix is 1970:
            "expires": (exp / 1_000_000 - 11644473600) if exp else None,
            "secure": bool(sec), "httpOnly": bool(http),
        })

    jwt = next((c["value"] for c in cookies if c["name"] == "_jwt"), "")
    if not cookies:
        sys.exit("no airbnb cookies found — are you logged into airbnb.com in Chrome?")

    body = {
        "platform": "airbnb", "status": "active",
        "cookies_json": cookies, "jwt": jwt,
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": "",
        "last_error": "",
    }
    req = urllib.request.Request(
        SUPABASE_URL + "?on_conflict=platform",
        data=json.dumps(body).encode(),
        headers={
            "apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal,resolution=merge-duplicates",
        }, method="POST")
    import urllib.error
    try:
        with urllib.request.urlopen(req) as r:
            print(f"uploaded {len(cookies)} cookies, jwt={'yes' if jwt else 'no'} -> {r.status}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")

if __name__ == "__main__":
    main()

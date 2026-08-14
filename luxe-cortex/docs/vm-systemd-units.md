# systemd units — Lightpanda + worker + luxe-cortex

These units live in [`deploy/systemd/`](../../deploy/systemd/). They run the
full JARVIS stack on the SSH VM so Airbnb inbox polling and the Cortex
dashboard survive reboot.

| Unit | Binary | Bind |
|------|--------|------|
| `luxe-lightpanda.service` | `lightpanda serve --host 127.0.0.1 --port 9222` | 127.0.0.1:9222 |
| `luxe-worker.service` | `npm start` in `/opt/luxe-mstr-rebuild/worker` | none (polls Supabase) |
| `luxe-cortex.service` | `wrangler dev --ip 127.0.0.1 --port 8787` | 127.0.0.1:8787 |

Public HTTPS is Caddy on :443 → 8787. See [`deploy/Caddyfile`](../../deploy/Caddyfile)
and [deploy-self-hosted-vm.md](./deploy-self-hosted-vm.md).

## One-shot install

From this Mac (SSH host `luxe-vm` in `~/.ssh/config`):

```bash
chmod +x deploy/install-vm.sh
./deploy/install-vm.sh
```

Tailscale path if the public IP is firewalled:

```bash
VM_HOST=luxe-vm-ts ./deploy/install-vm.sh
```

## Manual copy on the VM

```bash
sudo useradd -r -s /usr/sbin/nologin luxecortex || true
sudo chown -R luxecortex:luxecortex /opt/luxe-mstr-rebuild
sudo cp /opt/luxe-mstr-rebuild/deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now luxe-lightpanda luxe-worker luxe-cortex
sudo systemctl status luxe-lightpanda luxe-worker luxe-cortex
```

## Environment

Worker reads [`worker/.env.example`](../../worker/.env.example). Copy to
`/opt/luxe-mstr-rebuild/worker/.env` on the VM (`chmod 600`).

```
SUPABASE_URL=https://vbswmotdtyqakzuzkqui.supabase.co
SUPABASE_SERVICE_KEY=...
LIGHTPANDA_WS=ws://127.0.0.1:9222
POLL_MS=5000
SEND_DELAY_MS=90000
```

luxe-cortex `.dev.vars` is optional (`EnvironmentFile=-` in the unit).

## Lightpanda binary

Install Lightpanda to `/usr/local/bin/lightpanda` (the unit ExecStart path).
If it lives elsewhere, edit `luxe-lightpanda.service` before enabling.

Confirm CDP on the VM:

```bash
curl -sS http://127.0.0.1:9222/json/version
```

A 404 on `/json/new` is the failure that killed job `bj_healthcheck_*`.

## Cookie bootstrap (Mac → VM worker)

Epoch `platform_sessions` rows are ignored (cutoff 2000-01-01). Push a real
Airbnb login from this Mac:

```bash
# Chrome must be closed (it locks the cookie DB)
python3 scripts/airbnb_cookie_push.py
```

Then:

```bash
python3 scripts/pipeline_smoke.py
```

## Smoke checks on the VM

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/cortex   # 200
sudo journalctl -u luxe-worker -n 50 --no-pager
sudo journalctl -u luxe-lightpanda -n 30 --no-pager
```

## Pixel

1. Point DNS `cortex.yourdomain.com` at the VM public IP (`18.116.200.10`).
2. `sudo apt install -y caddy` (or Amazon Linux equivalent), copy
   [`deploy/Caddyfile`](../../deploy/Caddyfile), replace the hostname, reload Caddy.
3. On the Pixel open `https://cortex.yourdomain.com/cortex`.
4. Chrome menu → Add to Home screen.

Jarvis voice stays on the Mac. Point it at the same URL:

```bash
export JARVIS_MINDMAP_URL="https://cortex.yourdomain.com/cortex"
# or set jarvis_mindmap_url in Jarvis-cortex/config/api_keys.json
# or copy deploy/cortex.env.example → deploy/cortex.env and fill it in
jarvis-cortex
```

# systemd units — Lightpanda + worker + luxe-cortex + always-on watcher

These units live in [`deploy/systemd/`](../../deploy/systemd/). They run the
full JARVIS stack on the SSH VM so Airbnb inbox polling and the Cortex
dashboard survive reboot — **Mac off is fine**; the VM is the 24/7 plane.

| Unit | Binary | Bind |
|------|--------|------|
| `luxe-lightpanda.service` | Lightpanda CDP (`lightpanda serve` or `~/lightpanda-start.sh`) | 127.0.0.1:9222 |
| `luxe-worker.service` | `npm start` (worker polls Supabase `browser_jobs`) | none |
| `luxe-cortex.service` | `wrangler dev --ip 127.0.0.1 --port 8787` (needs bun) | 127.0.0.1:8787 |
| `luxe-pipeline-watch.service` | `python3 scripts/jarvis_pipeline_watch.py` (or `Jarvis-cortex/pipeline_daemon.py`) | none |
| `luxe-jarvis-cortex.service` | optional PyQt UI (disabled by default; needs display/Xvfb) | — |

Legacy home layout (`LEGACY_HOME=1`): repo at `/home/ec2-user/luxe-mstr-rebuild`,
worker at `/home/ec2-user/luxe-worker`, binary at `/home/ec2-user/lightpanda`.
Older units may still be named `lightpanda.service`.

Public HTTPS is Caddy on :443 → 8787. See [`deploy/Caddyfile`](../../deploy/Caddyfile)
and [deploy-self-hosted-vm.md](./deploy-self-hosted-vm.md).

Live outreach gate: [`docs/PIPELINE_LIVE_GATE.md`](../../docs/PIPELINE_LIVE_GATE.md)
(exact phrase **GO FOR IT**).

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
sudo systemctl enable --now luxe-lightpanda luxe-worker luxe-cortex luxe-pipeline-watch
# Optional PyQt Jarvis UI (needs display/Xvfb — prefer pipeline-watch for 24/7):
# sudo systemctl enable --now luxe-jarvis-cortex
sudo systemctl status luxe-lightpanda luxe-worker luxe-cortex luxe-pipeline-watch
```

## Always-on Jarvis (24/7)

The **always-on plane** is VM systemd, not a laptop process:

| Unit | Role |
|------|------|
| `luxe-lightpanda` | Lightpanda CDP for Airbnb |
| `luxe-worker` | Continuous claim/process of `browser_jobs` |
| `luxe-cortex` | Live mindmap + EventSource at `:8787/cortex` |
| `luxe-pipeline-watch` | Headless Jarvis watcher: status + auto `session_refresh` |

`luxe-jarvis-cortex.service` is optional (PyQt voice UI). Prefer
`luxe-pipeline-watch` when the Mac is off — it uses the same
`luxe_supabase` tools without a display.

```bash
sudo systemctl enable --now luxe-pipeline-watch
sudo journalctl -u luxe-pipeline-watch -f
```

Point any Jarvis UI at cortex (never root `dashboard/` demo):

```bash
export JARVIS_MINDMAP_URL="https://cortex.yourdomain.com/cortex"
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
# Worker honors payload.dry_run from Jarvis. Live unlock is GO FOR IT
# (settings.pipeline_live mirror + optional LUXE_PIPELINE_LIVE=1).
# See docs/PIPELINE_LIVE_GATE.md.
```

luxe-cortex `.dev.vars` is optional (`EnvironmentFile=-` in the unit).

## Live arming (dry-run gate)

Airbnb `send_message` stays **dry-run** until:

1. Operator says the exact phrase **`GO FOR IT`** to Jarvis, or calls `arm_live`
   with that phrase → writes `Jarvis-cortex/config/pipeline_live.armed` **and**
   mirrors `settings.pipeline_live.armed=true` in Supabase (VM worker reads this).
2. Per-message `confirm_send=true` on the same `queue_job`.

That phrase alone arms the master switch; `confirm_send` is the per-DM safety.
Disarm with `disarm_live` (no special phrase). See [`docs/PIPELINE_LIVE_GATE.md`](../../docs/PIPELINE_LIVE_GATE.md).

Optional ops override: `LUXE_PIPELINE_LIVE=1` in `worker/.env` (defense in depth).

## Cortex build note

Do **not** run `bun run build` on small EC2 instances — it can OOM and wedge SSH.
`deploy/install-vm.sh` builds cortex on the Mac (`BUILD_CORTEX_LOCAL=1` default) and
rsyncs `luxe-cortex/dist/`. Copy `.dev.vars` separately (never commit). Then:

```bash
sudo systemctl enable --now luxe-cortex
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/cortex
```

## Always-on stack (24/7)

These units are the authority — not a laptop process:

| Unit | Role |
|------|------|
| `luxe-lightpanda` | CDP browser for Airbnb jobs |
| `luxe-worker` | Claims `browser_jobs`, writes sessions/leads to Supabase |
| `luxe-cortex` | Mindmap + EventSource at `:8787/cortex` |
| `luxe-pipeline-watch` | Headless status loop + auto session_refresh |

`Restart=always` keeps them up across crashes. After install:

```bash
sudo systemctl enable --now luxe-lightpanda luxe-worker luxe-cortex luxe-pipeline-watch
```

Point Jarvis at the public cortex URL (not root `dashboard/` demo):

```bash
export JARVIS_MINDMAP_URL="https://cortex.yourdomain.com/cortex"
```

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

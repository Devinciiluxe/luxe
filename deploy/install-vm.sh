#!/usr/bin/env bash
# Sync the repo to the SSH VM and enable always-on systemd units.
#
# Default host alias: luxe-vm (see ~/.ssh/config).
# If ~/.ssh/config has a broken keyword (e.g. bare "ServerAlive"), use:
#   SSH_OPTS='-F /dev/null -i ~/.ssh/jarvis-key.pem' VM_HOST=ec2-user@18.116.200.10 ./deploy/install-vm.sh
#
# Layouts:
#   REMOTE_DIR=/opt/luxe-mstr-rebuild   (default, luxecortex user)
#   LEGACY_HOME=1                        use /home/ec2-user tree + existing lightpanda.service
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VM_HOST="${VM_HOST:-luxe-vm}"
# shellcheck disable=SC2206
SSH_CMD=(ssh ${SSH_OPTS:-} "$VM_HOST")
RSYNC_RSH="ssh ${SSH_OPTS:-}"

if [ "${LEGACY_HOME:-0}" = "1" ]; then
  REMOTE="${REMOTE_DIR:-/home/ec2-user/luxe-mstr-rebuild}"
  RUN_USER="${RUN_USER:-ec2-user}"
else
  REMOTE="${REMOTE_DIR:-/opt/luxe-mstr-rebuild}"
  RUN_USER="${RUN_USER:-luxecortex}"
fi

# Prefer building cortex on the Mac — small VMs OOM on `bun run build`.
# Set BUILD_CORTEX_LOCAL=0 to skip; REMOTE_CORTEX_BUILD=1 to force on-VM build.
if [ "${BUILD_CORTEX_LOCAL:-1}" = "1" ] && command -v bun >/dev/null 2>&1; then
  if [ -f "$ROOT/luxe-cortex/package.json" ]; then
    echo "[install-vm] building luxe-cortex locally (avoids VM OOM)…"
    (cd "$ROOT/luxe-cortex" && bun install && bun run build) || {
      echo "[install-vm] WARN: local cortex build failed — wrangler may not start until dist/ exists" >&2
    }
  fi
fi

echo "[install-vm] rsync → ${VM_HOST}:${REMOTE} (user=${RUN_USER})"
rsync -az --delete -e "$RSYNC_RSH" \
  --exclude node_modules --exclude .wrangler \
  --exclude venv --exclude .venv --exclude __pycache__ \
  --exclude '*.pyc' --exclude .git \
  --exclude 'worker/.env' --exclude '**/.dev.vars' --exclude '**/api_keys.json' \
  --exclude '**/*.pem' --exclude '**/pipeline_live.armed' \
  "$ROOT/" "${VM_HOST}:${REMOTE}/"

"${SSH_CMD[@]}" bash -s -- "$REMOTE" "$RUN_USER" "${LEGACY_HOME:-0}" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE="$1"
RUN_USER="$2"
LEGACY_HOME="$3"
cd "$REMOTE"

if [ "$LEGACY_HOME" != "1" ]; then
  if ! id luxecortex >/dev/null 2>&1; then
    sudo useradd -r -s /usr/sbin/nologin luxecortex
  fi
fi

# Worker deps — prefer synced tree; also mirror into legacy ~/luxe-worker when present.
if [ -f "$REMOTE/worker/package.json" ]; then
  (cd "$REMOTE/worker" && npm install)
fi
if [ "$LEGACY_HOME" = "1" ] && [ -d /home/ec2-user/luxe-worker ]; then
  rsync -a --delete \
    --exclude node_modules --exclude .env \
    "$REMOTE/worker/" /home/ec2-user/luxe-worker/
  (cd /home/ec2-user/luxe-worker && npm install)
fi

# Cortex: install deps only. Full `bun run build` OOMs small VMs — ship dist/ from Mac.
if command -v bun >/dev/null 2>&1 && [ -f "$REMOTE/luxe-cortex/package.json" ]; then
  (cd "$REMOTE/luxe-cortex" && bun install) || true
  if [ "${REMOTE_CORTEX_BUILD:-0}" = "1" ]; then
    (cd "$REMOTE/luxe-cortex" && bun run build) || true
  fi
  (cd "$REMOTE/luxe-cortex" && npx wrangler d1 migrations apply DB --local) || true
fi

sudo mkdir -p /etc/systemd/system
# Install repo units. On legacy home VMs, keep existing lightpanda.service /
# luxe-worker.service WorkingDirectory unless operators migrate fully.
sudo cp "$REMOTE/deploy/systemd/"*.service /etc/systemd/system/

# Patch pipeline-watch + jarvis units to this REMOTE path / user.
for u in luxe-pipeline-watch luxe-jarvis-cortex luxe-cortex luxe-worker luxe-lightpanda; do
  f="/etc/systemd/system/${u}.service"
  [ -f "$f" ] || continue
  sudo sed -i \
    -e "s|/opt/luxe-mstr-rebuild|${REMOTE}|g" \
    -e "s|^User=luxecortex|User=${RUN_USER}|" \
    -e "s|^Group=luxecortex|Group=${RUN_USER}|" \
    "$f"
done

# Legacy Lightpanda binary lives under ~/lightpanda — point unit at start script.
if [ -x /home/ec2-user/lightpanda-start.sh ]; then
  sudo tee /etc/systemd/system/luxe-lightpanda.service >/dev/null <<EOF
[Unit]
Description=Lightpanda CDP (Airbnb browser for LUXE worker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
EnvironmentFile=-/home/ec2-user/lightpanda.env
ExecStart=/home/ec2-user/lightpanda-start.sh
Restart=always
RestartSec=3
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
fi

# Legacy worker WorkingDirectory
if [ "$LEGACY_HOME" = "1" ] && [ -d /home/ec2-user/luxe-worker ]; then
  sudo tee /etc/systemd/system/luxe-worker.service >/dev/null <<EOF
[Unit]
Description=LUXE Airbnb browser_jobs worker (Lightpanda → Supabase)
After=network-online.target luxe-lightpanda.service
Wants=network-online.target
# Prefer luxe-lightpanda; tolerate older lightpanda.service name.
Wants=lightpanda.service

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=/home/ec2-user/luxe-worker
EnvironmentFile=/home/ec2-user/luxe-worker/.env
# Dry-run default until GO FOR IT / settings.pipeline_live.
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=append:/home/ec2-user/worker.log
StandardError=append:/home/ec2-user/worker.log

[Install]
WantedBy=multi-user.target
EOF
fi

if [ -f "$REMOTE/deploy/Caddyfile" ] && [ -d /etc/caddy ]; then
  sudo cp "$REMOTE/deploy/Caddyfile" /etc/caddy/Caddyfile
fi

if [ "$LEGACY_HOME" != "1" ]; then
  sudo chown -R luxecortex:luxecortex "$REMOTE" || true
fi

sudo systemctl daemon-reload

# Always-on plane: browser + worker + headless Jarvis watch.
# Cortex needs bun/wrangler — enable when present.
ENABLE=(luxe-lightpanda luxe-worker luxe-pipeline-watch)
if command -v bun >/dev/null 2>&1 || [ -x "$REMOTE/luxe-cortex/node_modules/.bin/wrangler" ]; then
  ENABLE+=(luxe-cortex)
fi

# Stop legacy unit name collision if both exist
if systemctl list-unit-files lightpanda.service 2>/dev/null | grep -q lightpanda; then
  sudo systemctl enable lightpanda.service || true
  sudo systemctl start lightpanda.service || true
fi

sudo systemctl enable --now "${ENABLE[@]}" || true
sudo systemctl restart luxe-worker || true
sudo systemctl restart luxe-pipeline-watch || true

echo "[install-vm] unit status:"
for u in lightpanda luxe-lightpanda luxe-worker luxe-cortex luxe-pipeline-watch; do
  printf '  %-22s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo n/a)"
done
curl -s -o /dev/null -w "cortex_http=%{http_code}\n" http://127.0.0.1:8787/cortex || true
curl -s -o /dev/null -w "lightpanda_json_version=%{http_code}\n" http://127.0.0.1:9222/json/version || true
REMOTE_SCRIPT

echo "[install-vm] done."
echo "  • Copy worker/.env if missing (never commit keys)."
echo "  • Bootstrap session: python3 scripts/airbnb_cookie_push.py (Chrome closed) OR queue session_refresh."
echo "  • Smoke: python3 scripts/jarvis_wire_check.py && python3 scripts/pipeline_smoke.py"
echo "  • Dry-run stays ON until you say GO FOR IT (see docs/PIPELINE_LIVE_GATE.md)."
echo "  • Jarvis mindmap: export JARVIS_MINDMAP_URL=https://cortex.yourdomain.com/cortex"
echo "  • 24/7: lightpanda + worker + cortex + pipeline-watch (PyQt UI optional)."
echo "  • If Host luxe-vm fails parsing ~/.ssh/config, fix ServerAliveInterval or use SSH_OPTS + VM_HOST=ec2-user@IP."
echo "  • If SSH banner hangs after a remote bun build, reboot the EC2 instance (OOM) then re-run with BUILD_CORTEX_LOCAL=1 (default)."
echo "  • Rotate Supabase service role key after ops if it may have been exposed."

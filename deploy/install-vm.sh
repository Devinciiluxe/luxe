#!/usr/bin/env bash
# Sync the repo to the SSH VM and enable systemd units.
# Host alias: luxe-vm (see ~/.ssh/config). Override: VM_HOST=luxe-vm-ts ./deploy/install-vm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VM_HOST="${VM_HOST:-luxe-vm}"
REMOTE="${REMOTE_DIR:-/opt/luxe-mstr-rebuild}"

echo "[install-vm] rsync → ${VM_HOST}:${REMOTE}"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .wrangler \
  --exclude venv --exclude .venv --exclude __pycache__ \
  --exclude '*.pyc' --exclude .git \
  "$ROOT/" "${VM_HOST}:${REMOTE}/"

ssh "$VM_HOST" bash -s -- "$REMOTE" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE="$1"
cd "$REMOTE"

if ! id luxecortex >/dev/null 2>&1; then
  sudo useradd -r -s /usr/sbin/nologin luxecortex
fi

# Worker deps
if [ -f "$REMOTE/worker/package.json" ]; then
  (cd "$REMOTE/worker" && npm install --omit=dev)
fi

# Cortex build if bun exists
if command -v bun >/dev/null 2>&1 && [ -f "$REMOTE/luxe-cortex/package.json" ]; then
  (cd "$REMOTE/luxe-cortex" && bun install && bun run build)
  (cd "$REMOTE/luxe-cortex" && npx wrangler d1 migrations apply DB --local) || true
fi

sudo mkdir -p /etc/systemd/system
sudo cp "$REMOTE/deploy/systemd/"*.service /etc/systemd/system/
if [ -f "$REMOTE/deploy/Caddyfile" ] && [ -d /etc/caddy ]; then
  sudo cp "$REMOTE/deploy/Caddyfile" /etc/caddy/Caddyfile
fi

sudo chown -R luxecortex:luxecortex "$REMOTE"
sudo systemctl daemon-reload
sudo systemctl enable luxe-lightpanda luxe-worker luxe-cortex
sudo systemctl restart luxe-lightpanda luxe-worker luxe-cortex || true
sudo systemctl is-active luxe-lightpanda luxe-worker luxe-cortex || true
curl -s -o /dev/null -w "cortex_http=%{http_code}\n" http://127.0.0.1:8787/cortex || true
REMOTE_SCRIPT

echo "[install-vm] done. On the VM: copy worker/.env if missing, then python3 scripts/pipeline_smoke.py from this Mac."

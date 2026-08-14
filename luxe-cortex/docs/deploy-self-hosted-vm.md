# Self-hosting luxe-cortex on your own VM/VPS (no Cloudflare account)

## Read this first — what you're actually getting

This app is built for Cloudflare's platform (D1 database, R2 storage, a
Durable Object). Outside Cloudflare's real infrastructure, the only way to
run it is `wrangler dev`'s **local emulation mode** — it runs the same Worker
code via `workerd` (Cloudflare's open-source runtime), but D1/R2/the Durable
Object are all emulated with local SQLite files on disk instead of real
distributed Cloudflare services. That's genuinely fine for a single-server,
single-instance setup — no free-tier limits, no Cloudflare account needed —
but you own uptime, backups, and scaling yourself, and there's no
multi-region/multi-instance story (it's one process on one machine). If you
outgrow that, `docs/deploy-cloudflare.md` is the real-infrastructure path.

## 1. Get the code onto the VM

From your local machine:

```bash
# whole project except node_modules/dist (those get rebuilt on the VM)
rsync -av --exclude node_modules --exclude dist --exclude .wrangler \
  /Users/devinci/luxe-mstr-rebuild/luxe-cortex/ \
  you@your-vm-host:/opt/luxe-cortex/
```

(Or `git clone` if this project is pushed to a repo the VM can reach.)

## 2. On the VM: install Bun + build

```bash
ssh you@your-vm-host
curl -fsSL https://bun.sh/install | bash   # if bun isn't already installed
cd /opt/luxe-cortex
bun install
bun run build
```

## 3. Apply migrations to the local (VM-side) database

```bash
npx wrangler d1 migrations apply DB --local
```

This creates the SQLite-backed emulated D1 under `.wrangler/state/v3/d1/` on
the VM. **Back this directory up regularly** — it's your actual data store
now, there's no separate managed database behind it.

## 4. Run it persistently with systemd

Don't just run `wrangler dev` in a terminal and disconnect — it dies with the
SSH session. Use a systemd service so it survives reboots and restarts on
crash.

Create `/etc/systemd/system/luxe-cortex.service`:

```ini
[Unit]
Description=luxe-cortex (JARVIS CORTEX + LUXEdesign)
After=network.target

[Service]
Type=simple
User=luxecortex
WorkingDirectory=/opt/luxe-cortex
ExecStart=/opt/luxe-cortex/node_modules/.bin/wrangler dev --ip 127.0.0.1 --port 8787 --persist-to /opt/luxe-cortex/.wrangler/state
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

(`--ip 127.0.0.1` — bind to localhost only; the reverse proxy in step 5
handles the public-facing side. Create a dedicated non-root `luxecortex` user
first: `sudo useradd -r -s /usr/sbin/nologin luxecortex` and `sudo chown -R
luxecortex:luxecortex /opt/luxe-cortex`.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now luxe-cortex
sudo systemctl status luxe-cortex   # confirm it's running
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/cortex   # expect 200
```

## 5. Reverse proxy + HTTPS with Caddy (simplest option)

Caddy gets you automatic Let's Encrypt HTTPS with almost no config.

```bash
sudo apt install -y caddy   # or your distro's equivalent
```

`/etc/caddy/Caddyfile`:

```
cortex.yourdomain.com {
	reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Point `cortex.yourdomain.com`'s DNS A/AAAA record at the VM's IP first —
Caddy issues the certificate automatically on first request once DNS
resolves.

### Alternative: nginx + certbot, if you'd rather use that

```nginx
server {
    listen 80;
    server_name cortex.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then `sudo certbot --nginx -d cortex.yourdomain.com` to add HTTPS.

## 6. Firewall

Only 80/443 need to be open to the world; 8787 should stay internal
(`127.0.0.1` binding in step 4 already ensures this — double-check with
`sudo ufw status` / your cloud provider's security group that 8787 isn't
separately exposed).

## Redeploying after changes

```bash
ssh you@your-vm-host
cd /opt/luxe-cortex
git pull   # or re-rsync from local
bun install
bun run build
npx wrangler d1 migrations apply DB --local   # only if migrations/ changed
sudo systemctl restart luxe-cortex
```

## Pointing the native app (Jarvis-cortex) at the VM instead of localhost

```bash
export JARVIS_MINDMAP_URL="https://cortex.yourdomain.com/cortex"
jarvis-cortex
```

(Or set it permanently in the `jarvis-cortex` launcher script at
`/opt/homebrew/bin/jarvis-cortex`.)

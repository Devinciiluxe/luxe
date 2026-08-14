# Deploying luxe-cortex to Cloudflare Workers (real, non-local)

This app (TanStack Start SSR + D1 + R2 + one Durable Object) is built
specifically for Cloudflare Workers — this is the path that gives you real
infrastructure (not the local SQLite emulation `wrangler dev` uses), a public
HTTPS URL, and Cloudflare's free tier covers it easily at this scale.

Everything below runs from `/Users/devinci/luxe-mstr-rebuild/luxe-cortex/`.

## 0. One-time prerequisites

- A Cloudflare account (free — https://dash.cloudflare.com/sign-up if you
  don't have one).
- `wrangler` is already installed as a devDependency in this project
  (`node_modules/.bin/wrangler`, invoke as `npx wrangler ...` or `bunx
  wrangler ...`).
- Log in once: `npx wrangler login` — opens a browser, authorizes the CLI.
  Verify with `npx wrangler whoami`.

## 1. Name the Worker

`wrangler.jsonc`'s `"name"` field is currently `"app-slug-placeholder"` — a
build-only placeholder (see the comments in the file). For a real deploy this
IS the name wrangler uses, so change it first:

```jsonc
"name": "luxe-cortex",   // lowercase + dashes, 3-63 chars, must be unique to your account
```

This also becomes part of the default URL: `https://luxe-cortex.<your-subdomain>.workers.dev`.

## 2. Create the real D1 database

```bash
npx wrangler d1 create luxe-cortex-db
```

This prints a `database_id` (a real UUID). Copy it into `wrangler.jsonc`,
replacing the placeholder zeros:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "luxe-cortex-db",
    "database_id": "PASTE-THE-REAL-UUID-HERE" }
],
```

## 3. Create the real R2 bucket

```bash
npx wrangler r2 bucket create luxe-cortex-assets
```

No id to copy — `wrangler.jsonc`'s `r2_buckets` block (already present,
`binding: "STORAGE"`) just needs the bucket name to match, which it already
does.

## 4. Durable Object

Already fully declared in `wrangler.jsonc` (`durable_objects.bindings` +
the `migrations` block with `new_sqlite_classes: ["NexusHub"]`) and the class
is exported from `src/server.ts`. Nothing to create manually — `wrangler
deploy` provisions it automatically from that config.

## 5. Apply migrations to the REAL (remote) database

Everything in `migrations/*.sql` (schema + seed data — 26 demo leads, same
mock data you saw locally) needs to be applied to the remote D1 you just
created:

```bash
npx wrangler d1 migrations apply DB --remote
```

(Note: `--remote` is the important flag — without it, this applies to the
local emulated DB instead, which is what plain `wrangler d1 migrations
apply DB` without a flag does during `wrangler dev`.)

If/when deploying without Supabase credentials, cortex will fail loudly
(empty leads + error banner) rather than showing demo fixtures. Live
`allLeads()` / metrics require `LUXE_SUPABASE_URL` + `LUXE_SUPABASE_SERVICE_KEY`
in `.dev.vars` / Worker secrets. Do not point operators at root `dashboard/`.

## 6. Build

```bash
bun run build
```

Produces `dist/client/` (static assets) and `dist/server/server.js` (the
Worker entry — `wrangler.jsonc`'s `main` already points here).

## 7. Deploy

```bash
npx wrangler deploy
```

Output includes your live URL, e.g.:

```
https://luxe-cortex.<your-subdomain>.workers.dev
```

The dashboard is at `/cortex` on that domain (e.g.
`https://luxe-cortex.<your-subdomain>.workers.dev/cortex`), the marketing
site is at `/`.

## 8. Custom domain (optional)

In the Cloudflare dashboard → Workers & Pages → luxe-cortex → Settings →
Domains & Routes → Add a custom domain. Requires the domain's DNS to already
be on Cloudflare.

## Redeploying after changes

Every time you change source and want it live:

```bash
bun run build && npx wrangler deploy
```

If a change adds/edits a `migrations/*.sql` file, also run:

```bash
npx wrangler d1 migrations apply DB --remote
```

before or after deploying (migrations are additive/idempotent — safe to run
even if there's nothing new).

## Pointing the native app (Jarvis-cortex) at the deployed URL instead of localhost

`Jarvis-cortex/ui.py`'s `MindMapView` reads the mind-map URL from the
`JARVIS_MINDMAP_URL` environment variable, falling back to
`http://localhost:8787/cortex`. To point the native app at the real deployed
site instead of a local `wrangler dev`:

```bash
export JARVIS_MINDMAP_URL="https://luxe-cortex.<your-subdomain>.workers.dev/cortex"
jarvis-cortex
```

(Or set it permanently in your shell profile / the `jarvis-cortex` launcher
script at `/opt/homebrew/bin/jarvis-cortex`.)

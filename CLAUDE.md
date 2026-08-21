# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this repo is

This is the **luxe-mstr-rebuild** monorepo: it hosts several related but
independently-deployed projects for a solo-operator agency business (LUXE)
that does automated Airbnb-host outreach plus an AI cinematic-video product.
The projects share a Supabase backend and a voice-assistant ("Jarvis")
control layer, but each subdirectory is its own app with its own toolchain —
there is no unified root build.

| Directory | What it is | Stack |
|---|---|---|
| `Jarvis-cortex/` | **Active** JARVIS voice assistant, wired into the LUXE pipeline (Supabase + cortex actions) | Python 3.11/3.12, PyQt6, Gemini Live API |
| `Jarvis/` | Upstream "Mark L" assistant template this was forked from — no LUXE/pipeline integration | Python |
| `luxe-cortex/` | **Live** internal ops dashboard ("JARVIS CORTEX") — 3D lead-brain HUD, reads/writes the real pipeline | TanStack Start (React 19), Cloudflare Workers + D1/R2, bun |
| `luxe-design/` | Client-facing product site, LUXEdesign.online — AI drone-flythrough video product | TanStack Start (React 19), Cloudflare Workers, bun |
| `worker/` | Browser-automation worker: polls Supabase `browser_jobs`, drives Airbnb via Lightpanda/CDP | Node + TypeScript (`tsx`) |
| `dashboard/` | **Redirect entrypoint** — `npm start` forwards every request to `luxe-cortex`'s live `/cortex` UI. No UI or data of its own. | Node (no deps) |
| `scripts/` | Python ops scripts: pipeline audit, smoke tests, wire checks, cookie bootstrap, always-on watcher | Python |
| `deploy/` | systemd units + Caddyfile + VM install script for the 24/7 VM deployment | shell/systemd |
| `docs/` | Cross-cutting docs; most importantly `PIPELINE_LIVE_GATE.md` | Markdown |
| `.claude/agents/`, `.cursor/agents/` | Pre-existing specialized subagents for this repo (see below) | — |

**Confirm with the operator:** `Jarvis/` and `Jarvis-cortex/` look like two
generations of the same assistant (`Jarvis-cortex` has all the LUXE/Supabase
integration `Jarvis` lacks). Treat `Jarvis-cortex/` as the one to modify
unless told otherwise, and ask before touching `Jarvis/`.

## Demo vs. live — the one map (read this first)

This codebase has **several things that look like real pipeline data but
aren't**, plus one thing that looks like a demo but is a live write path.
Before trusting or displaying any number, check this table — don't infer
"live" from a file being inside `luxe-cortex/` or "demo" from a name alone:

| Thing | Status | Why |
|---|---|---|
| Supabase project `vbswmotdtyqakzuzkqui` (`leads`, `browser_jobs`, `platform_sessions`, `messages`, `settings`) | ✅ **LIVE — the only source of truth** | Real Airbnb pipeline, 5,000+ leads. Written by `worker/`, read by `Jarvis-cortex/actions/luxe_supabase.py` and `luxe-cortex/src/lib/db.server.ts` |
| `luxe-cortex` dashboard, `/cortex` route | ✅ **LIVE UI** | Reads the same Supabase tables directly via PostgREST — not a separate copy of the data |
| `luxe-cortex`'s own **D1** tables `leads` / `messages` / `events` (defined in `migrations/0001_init.sql`) | ⚠️ **Dead / legacy** — looks real, isn't used | Superseded by Supabase. D1 in this app is only actually read/written for `meetings` and `proposals` now |
| Root `dashboard/` | ✅ **Redirect, not a data path** | `npm start` runs `server.mjs`, which 302s every request to `luxe-cortex`'s live `/cortex` (via `JARVIS_MINDMAP_URL`, default `http://localhost:8787/cortex`). It used to ship a static demo (`public/mission-data.js`) that refused to start; that demo UI and the orphaned `live-data.mjs` (wired to an unrelated, non-existent-in-this-repo Postgres schema — `orders`/`video_jobs`/`escalations`, a different project's data model) were removed rather than pointed at real data, since duplicating `/cortex`'s live surface would just be a second copy to drift out of sync |
| Supabase project `dnnagfjwctjtrliftolb` ("LUXE PIPELINE") | 🚫 **Dead** | `RESTORE_FAILED`, holds none of this data — never point anything at it |
| "Lead Hunter" scrape (`createScrapedLead`, `run_hunter`, `Math.random()`-generated leads) | 🚫 **Dead — hard-blocked**, looked live before | Previously fabricated fake leads into what looked like the live path. Now blocked in three places: `luxe-cortex/src/lib/jarvis.server.ts` (throws), `luxe-cortex/src/routes/api/jarvis.ts` (HTTP 410), `luxe-cortex/src/lib/store.ts` (`sweep()` warns only). Never re-enable or reimplement this — real intake is `scrape_listing`/`scrape_search` browser_jobs run by `worker/` against real Airbnb pages |
| `Jarvis-cortex/actions/luxe_pipeline.py` (`/api/jarvis` cortex REST client) | ✅ **Live, but writes-only** | Mutates Supabase-backed rows (`set_stage`, etc.) — never use it to *read* pipeline stats; use `luxe_supabase.py` for that |

If you're ever unsure whether a number, table, or UI panel is real, check
this table first rather than guessing from file location or naming.

## The one rule that matters most: live-send safety

Airbnb outreach is a **real automated messaging system** to real hosts. All
of the following is load-bearing and must never be relaxed casually:

- **Dry-run is the default** for every `send_message` job. It only goes live
  when the operator says the exact phrase **`GO FOR IT`** (case-sensitive for
  the API `phrase=` field; case-insensitive tolerated only for spoken/STT
  input). **Never invent or guess this phrase on the model's behalf.**
- Arming also requires per-message `confirm_send=true` — two independent
  gates, not one.
- The gate is mirrored between `Jarvis-cortex/config/pipeline_live.armed`
  (local) and Supabase `settings.pipeline_live` (so the VM worker sees the
  same state). Worker also honors `LUXE_PIPELINE_LIVE=1` as an ops override.
- Safe job kinds (`session_refresh`, `inbox_sync`, `scrape_listing`) can be
  queued freely; `send_message` cannot.
- See `docs/PIPELINE_LIVE_GATE.md` and `Jarvis-cortex/actions/pipeline_arm.py`
  for the authoritative logic before changing anything in this area.

## Secrets

Never print, log, or commit: `.env`, `**/config/api_keys.json`, `.dev.vars`,
cookies, JWTs, or Supabase service keys. `.gitignore` already blocks these
paths — don't override or work around that. Session bootstrap
(`scripts/airbnb_cookie_push.py`) reads a real Chrome login locally and
explicitly never prints cookie/JWT values; keep that property if you touch it.
`luxe-cortex/src/lib/auth.server.ts` also hardcodes a single owner PIN for
dashboard login — don't print or log it either, and don't widen that auth
model without asking (it's deliberately single-operator, cookie+HMAC, no
user table).

## Per-project dev workflows

**`Jarvis-cortex/` (Python)**
```bash
cd Jarvis-cortex
pip install -r requirements.txt
python main.py                 # PyQt6 HUD + Gemini Live voice loop
```

**`luxe-cortex/` (bun, Cloudflare Workers)**
```bash
cd luxe-cortex
bun install
bun run dev          # vite/wrangler dev, served at :8787, dashboard at /cortex
bun run lint          # eslint
bun run typecheck     # tsc --noEmit
bun run build          # tsc + vite build in parallel
```

**`luxe-design/` (bun, Cloudflare Workers)**
```bash
cd luxe-design
bun install
bun run dev
bun run lint
bun run typecheck     # tsr generate + tsc --noEmit
bun test tests/*.test.ts
bun run build          # check:ui -> tsr generate -> tsc -> vite build
```
Both `luxe-cortex` and `luxe-design` use `wrangler.jsonc` for **local dev
only** — deploy CI regenerates it from trusted manifest metadata, so treat
`name`/binding ids in that file as placeholders, not real config.

**`worker/` (Node/TS, runs on the VM)**
```bash
cd worker
npm install
cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_SERVICE_KEY
npm start               # tsx src/worker.ts — requires Lightpanda running on :9222
```

**`dashboard/` (Node, no deps)**
```bash
cd dashboard
npm start   # redirect server; -> http://localhost:8787/cortex by default
JARVIS_MINDMAP_URL=https://cortex.yourdomain.com/cortex npm start   # point at a deployed cortex
```

**Ops / verification scripts (run from repo root)**
```bash
python3 scripts/jarvis_wire_check.py   # confirms Jarvis + cortex share one Supabase lead count
python3 scripts/pipeline_smoke.py      # end-to-end smoke, dry-run only, never arms live
python3 scripts/pipeline_audit.py      # refreshes scripts/audit-output.json
```

## `luxe-cortex` internals — the ops dashboard

Both `luxe-cortex` and `luxe-design` are generated from the same **Higgsfield
app template** (Cloudflare Workers + TanStack Start + the `@higgsfield/quanta`
design-system workspace package, `app.manifest.json` declaring bindings,
`components.json` for shadcn, per-folder `AGENTS.md`/`README.md` template
docs). `luxe-cortex` used the template's **"custom" layout** escape hatch
(`src/layouts/custom.tsx` equivalent doesn't exist here — it went further
custom than that, straight into a bespoke 3D scene) rather than the stock
studio/preset/app-detail layouts, because the product is a 3D lead-brain HUD,
not a generation tool.

- **`app.manifest.json`**: `db: true, r2: true, kv: false, durableObject:
  "NexusHub"` — this app is provisioned with D1, R2, and one Durable Object.
- **Entry/routing**: `src/router.tsx` + file-based routes in `src/routes/`
  (see `src/routes/README.md`) — `routeTree.gen.ts` is generated, never hand-edit
  it. Key routes:
  - `routes/cortex.tsx` — the dashboard itself (`/cortex`). SSR-loads a
    `Snapshot` via `getSnapshot()`, then hands off to the client `useCortex()`
    hook for live state.
  - `routes/api/jarvis.ts` — machine-to-machine REST for the JARVIS voice
    assistant (GET pipeline snapshot / single lead; POST actions like
    `set_stage`, `compose_reply`, `make_proposal`, `book_slot`,
    `mark_no_show`, `bump_score`, `toggle_automation`). Auth is a static
    bearer token (`JARVIS_API_KEY`), separate from the dashboard's own
    cookie session. `run_hunter` is deliberately hard-blocked (410).
  - `routes/api/events.ts` — SSE endpoint the browser subscribes to for live
    frames (see NexusHub below).
  - `routes/api/pin.ts` — owner PIN login, sets the session cookie.
  - `routes/api/proposals.$id.ts` — serves a generated proposal doc.
- **Data layer (`src/lib/db.server.ts`)**: leads, messages, events, and
  settings all read/write **Supabase** via PostgREST (`supabaseFetch`/
  `supabaseWrite`), mapping Supabase's stage vocabulary
  (`new`/`contacted`/`replied`/...) onto this app's `Stage` union
  (`pending_outreach`/`outreach_sent`/`replied`/`qualified`/`won`/`lost`/
  `no_show`). Local D1 is legacy/unused for leads (see the demo-vs-live table
  above) and only actually serves `meetings`/`proposals`.
  `src/lib/migrate.server.ts` self-applies `migrations/000*.sql` lazily on
  first D1 access (the deploy CI does not run migrations for you); every
  statement is `CREATE TABLE IF NOT EXISTS` / idempotent by design.
- **Automation engine (`src/lib/jarvis.server.ts`)**: `composeReply()` does
  simple keyword-intent detection (pricing/booking/no-show/report/proposal/
  onboarding/multi-site) and drafts a canned "Jarvis" reply, moves the lead's
  stage, and bumps its score. `generateProposalDoc()` writes a markdown doc to
  R2 (`STORAGE` binding) and a row into D1 `proposals`. `bookSlot()` handles
  meeting scheduling with overlap checks.
- **Live fan-out**: `src/lib/hub.server.ts` defines `NexusHub`, a Durable
  Object (binding `ROOMS`) that keeps open SSE writer streams and broadcasts
  `LiveFrame` JSON to every connected tab (`/subscribe` to listen, `/push` to
  publish, from `broadcastToHub()`). `jarvis.server.ts`'s `emit()` and the
  `/api/jarvis` route both push frames through this single hub so every open
  tab — including a native app embedding the dashboard — sees the same
  state. Client side, `src/lib/store.ts`'s `useCortex()` hook owns an
  `EventSource` with reconnect/backoff plus a 12s poll-fallback against
  `getSnapshot()`, and explicitly **never substitutes fixture/demo data on
  error** — it surfaces `dataError` instead.
- **Bindings (`src/lib/bindings.server.ts`)**: typed accessor over Cloudflare
  `env` — `DB` (D1), `STORAGE` (R2), `KV`, `CONTAINER`, `ROOMS` (the
  NexusHub DO), plus app-specific env vars `LUXE_SUPABASE_URL`,
  `LUXE_SUPABASE_SERVICE_KEY`, `JARVIS_API_KEY`. Everything is optional/typed
  as possibly-undefined — guard before use rather than assuming a binding
  exists.
- **Auth (`src/lib/auth.server.ts`)**: single-operator PIN login → signed
  HttpOnly cookie (HMAC-SHA256 over an expiry timestamp). Deliberately not a
  multi-user system; don't add one without asking.
- **UI**: `src/components/brain-scene.tsx` (Three.js, lazy client-only) draws
  the 3D lead-node brain; `brain-static.tsx` is presumably the SSR-safe
  fallback. `chrome.tsx` (Header/DiagnosticsStrip/CommandPalette),
  `panels.tsx` (HunterLog/Sparkline/MetricsStack/NodeInspector),
  `lead-list.tsx`, `chat.tsx` compose the rest of the HUD. `src/hooks/use-voice.ts`
  wires the browser-side voice command parser (`parseCommand`) — note the
  dashboard can be embedded inside `Jarvis-cortex`'s own PyQt6 window, in
  which case `window.__jarvisBridge` exists and the in-app `speak()` call is
  skipped so audio doesn't double up (see the comment in `routes/cortex.tsx`).
- **`src/components/AGENTS.md`** documents the Higgsfield template's shared
  component contract (asset picker, generation cards, etc.) — largely
  inherited scaffolding; most of it isn't exercised by this app's custom HUD,
  but don't hand-roll a replacement for anything it says is canonical if you
  do touch the template layer.

## `luxe-design` internals — LUXEdesign.online

Same Higgsfield template, used much closer to its native shape: an AI
generation product (image/video), here themed as a cinematic drone-flythrough
video service. `app.manifest.json` has **no bindings enabled** (`db`, `r2`,
`kv` all false/null) — this app has no server-side storage of its own; it's a
front-end over the client's own footage/video pipeline (see `luxe-fulfillment`
skill for the actual order-fulfillment workflow, which is a separate concern
from this codebase) plus the Higgsfield `@higgsfield/fnf` generation-jobs
client library.

- **Layout**: uses the template's `custom` layout properly —
  `src/layouts/custom.tsx` + `src/layouts/AGENTS.md` (read this before
  touching layout structure: it mandates `CustomAppShell` for
  nav/background/shell, `WorkspaceContent` for the center pane in `page` /
  `canvas` / `generations` mode, and caps panels at 3–4 primary controls with
  progressive disclosure via Accordion/Modal/Dropdown).
- **Routes**: `routes/index.tsx` is the public marketing landing page (the
  "journey" described in `design-brief.md` — five overlapping video legs:
  Arrival → Experience → Signature Flight → Estate Flight → Estate Grand
  Tour). `routes/app.tsx` renders `CustomTemplate` (the product surface
  itself) and supports `?preview=1` for previewing without side effects.
- **Component library**: much larger than `luxe-cortex`'s — this app uses the
  template's full generation-product kit: `asset-library.tsx`
  (`AssetLibraryModal`, the canonical upload/asset picker — never build a
  custom one, per `src/components/AGENTS.md`), `composer/`, `gallery/`,
  `generation-card/`, `generation-detail.tsx`, `history-grid.tsx`,
  `template-modal.tsx`/`template-picker.tsx`, `dropzone/`, `upload-field/`,
  `scroll-scrub/` (the scroll-scrubbed video journey on the landing page),
  plus a full `components/ui/` shadcn v4 kit (button, dialog, sidebar, chart,
  etc.) skinned to the Quanta `--hf-*` tokens. **Read
  `src/components/AGENTS.md` and `src/layouts/AGENTS.md` before adding any
  new UI** — they define hard rules (e.g. every upload trigger must open
  `AssetLibraryModal`; every generating-state placeholder must be
  `<GenerationCard state="generating" />`; no raw hex colors / arbitrary
  Tailwind color classes / `dark:` classes in app code).
- **Generation results**: `src/lib/higgsfield-generation-results.ts` maps a
  `@higgsfield/fnf` `Generation` job into a discriminated
  `GenerationMediaPreview` (`image` | `video` | `empty`, with pending/failed/
  preview-unavailable reasons) — this is the shared logic for rendering any
  in-flight or finished generation consistently.
- **Design-inspector module** (`src/module/design-inspector/`): template-local
  runtime for the Higgsfield "Supercomputer" visual editor's live-preview
  mode. Only active when `HF_DESIGN_INSPECTOR=1` (`bun run dev:design`);
  production builds ship none of it. Don't hand-add `data-hf-*` attributes —
  metadata lives in a `WeakMap`, not the DOM (see the module's own README).
- **Tests**: `tests/*.test.ts` (`bun test`) — `history-performance.test.ts`,
  `landing-contract.test.ts`, `security-headers.test.ts`.
- **Adaptation checks**: `bun run check:ui` (design-system lint — no raw
  colors, no arbitrary classes, no `dark:`) and `bun run check:adapted`
  (fails if template placeholder/mock content markers are still present) are
  both meant to be run before considering a UI change done, per
  `src/layouts/AGENTS.md`'s pre-finish checklist.

## Data model notes

See the demo-vs-live table above for which store is real per table. One
convention that applies regardless: D1 migrations in both `luxe-cortex` and
`luxe-design` are **additive only** (`CREATE TABLE IF NOT EXISTS` /
`ADD COLUMN`) — one database is shared between preview and prod, so a
destructive migration hits real data. That includes `luxe-cortex`'s now-dead
`leads`/`messages`/`events` D1 tables: leave the migration file alone even
though the tables are unused — don't "clean it up" by dropping them.

## Deployment

- The VM (24/7 plane) runs the always-on services as systemd units in
  `deploy/systemd/`: `luxe-lightpanda`, `luxe-worker`, `luxe-cortex`,
  `luxe-pipeline-watch` (the optional PyQt6 `luxe-jarvis-cortex` unit is
  disabled by default — it needs a display). See
  `luxe-cortex/docs/vm-systemd-units.md` for install/topology and
  `deploy/install-vm.sh` for the one-shot installer.
- `luxe-cortex` and `luxe-design` deploy to Cloudflare Workers via the
  Higgsfield platform's own CI, which regenerates `wrangler.jsonc` from
  trusted manifest metadata at deploy time — see
  `luxe-cortex/docs/deploy-cloudflare.md`.

## Existing specialized subagents (don't duplicate their work)

- `.claude/agents/cso-agent.md` — orchestrator across LUXE pipeline functions.
- `.claude/agents/systems-data-manager.md` — Supabase schema / job-queue health.
- `.claude/agents/lead-qualification-specialist.md` — lead scoring.
- `.claude/agents/airbnb-outreach-specialist.md` — drafts outreach; never
  arms live sends itself (requires the operator's exact phrase + confirmation).
- `.cursor/agents/pipeline-integrity.md` — reviews pipeline/Supabase/dry-run
  changes for regressions (fake data, bypassed gates, wrong source of truth).
  Worth re-running this checklist mentally after touching anything in
  `Jarvis-cortex/actions/`, `worker/`, or `luxe-cortex`'s data layer.

## General conventions observed in the code

- Python modules favor plain `urllib` over `requests`, explicit error dicts
  (`{"ok": False, "error": ...}`) over exceptions bubbling to the caller, and
  comments that explain *why* a safety check exists, not what the code does —
  match that style in `Jarvis-cortex/` and `scripts/`.
- TS/React projects use bun, Tailwind v4, Radix UI primitives, TanStack
  Router/Query/Start, and Zod. Both `luxe-cortex` and `luxe-design` are
  built from the same Higgsfield app template — check for a `AGENTS.md` in
  the relevant `src/` subfolder before adding components or changing layout;
  they encode hard rules from the template, not just suggestions.

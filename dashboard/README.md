# Root `dashboard/` — redirects to the live pipeline UI

This folder is no longer a demo. `npm start` runs a tiny redirect server
(`server.mjs`): every request gets a 302 to the real, Supabase-backed LUXE
pipeline UI at **luxe-cortex**'s `/cortex` route. There is exactly one live
ops surface in this repo — this folder doesn't duplicate it, it just points
here to it.

```bash
cd dashboard
npm start                                                          # -> http://localhost:8787/cortex
JARVIS_MINDMAP_URL=https://cortex.yourdomain.com/cortex npm start  # prod target
```

Target URL comes from `JARVIS_MINDMAP_URL` — the same env var used
elsewhere in this repo for the live cortex URL (see
`deploy/cortex.env.example`, `Jarvis-cortex/ui.py`) — defaulting to
`http://localhost:8787/cortex` for local dev. `PORT` (default `3000`)
controls what this redirect server itself listens on.

## History

This folder used to ship a static "MISSION JARVIS" demo
(`public/mission-data.js` + a canvas UI) that intentionally refused to
`npm start`, plus a `live-data.mjs` wired to an unrelated, already-orphaned
Postgres schema (`orders`/`video_jobs`/`escalations` — a different project's
data model, not this repo's Supabase pipeline; no `DATABASE_URL` for it
exists anywhere in this repo). Both were removed rather than wired up to
real data, since the only real live pipeline this repo has is Supabase,
already served live at `luxe-cortex` `/cortex`. See git history if you need
the old files.

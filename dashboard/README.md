# Root `dashboard/` — DEMO ONLY (not live)

**This directory is not the live LUXE pipeline UI.**

| | Root `dashboard/` | **luxe-cortex** `/cortex` |
|---|---|---|
| Data | Static `public/mission-data.js` | Supabase + EventSource |
| `npm start` | Refuses (`refuse-demo-start.mjs`) | `wrangler` / bun on `:8787` |
| Jarvis mindmap | Never point here | `JARVIS_MINDMAP_URL=…/cortex` |

- Numbers you see are a **demo snapshot** — not Postgres/Supabase truth.
- There is no `server.mjs`; `live-data.mjs` is unused historical reference.
- Live leads, jobs, sessions, and SSE live in **luxe-cortex** (`/cortex`)
  backed by Supabase + the VM worker + Lightpanda.

Point Jarvis at cortex:

```bash
export JARVIS_MINDMAP_URL="http://localhost:8787/cortex"
# or the VM public URL, e.g. https://cortex.yourdomain.com/cortex
```

**Operator glance test:** red DEMO banner + “DEMO VALUES” on this folder;
cyan **LIVE · SUPABASE** chips on luxe-cortex.

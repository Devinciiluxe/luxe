#!/usr/bin/env node
/**
 * Root dashboard has no server.mjs and must not pretend to be live Postgres.
 * Live UI: luxe-cortex on :8787/cortex (JARVIS_MINDMAP_URL).
 */
console.error(`
╔══════════════════════════════════════════════════════════════╗
║  DEMO ONLY — not live Supabase / Postgres                    ║
║  public/mission-data.js is a static snapshot.                ║
║  Use luxe-cortex:  wrangler/bun on :8787 → /cortex           ║
║  export JARVIS_MINDMAP_URL=http://localhost:8787/cortex      ║
╚══════════════════════════════════════════════════════════════╝
`);
process.exit(1);

#!/usr/bin/env node
/**
 * Root dashboard entrypoint — redirects to the live LUXE pipeline UI.
 *
 * This folder used to ship a static demo (public/mission-data.js) and
 * refuse to start. There is exactly one live ops surface in this repo:
 * luxe-cortex's /cortex route (Supabase-backed leads, jobs, sessions, SSE).
 * Rather than duplicate that surface, every request here is forwarded
 * straight to it — one live UI, no second copy of the data to drift.
 *
 * Target URL: JARVIS_MINDMAP_URL (the same env var used elsewhere in this
 * repo for the live cortex URL — see deploy/cortex.env.example and
 * Jarvis-cortex/ui.py), falling back to the local wrangler dev default.
 */
import http from "node:http";

const TARGET = (process.env.JARVIS_MINDMAP_URL || "http://localhost:8787/cortex").trim();
const PORT = Number(process.env.PORT) || 3000;

http
  .createServer((_req, res) => {
    res.writeHead(302, { Location: TARGET });
    res.end();
  })
  .listen(PORT, () => {
    console.log(`[dashboard] redirecting all requests to ${TARGET} (listening on :${PORT})`);
  });

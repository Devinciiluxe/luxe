// Server-Sent Events stream proxied through the NexusHub Durable Object.
// The chat UI subscribes here for live node-glow, new leads, and chat replies.
// In dev without ROOMS, keep-alive pings + store.ts 60s snapshot poll keep
// Jarvis on live Supabase state (never static mission-data.js).
import { createFileRoute } from "@tanstack/react-router";
import { NexusHub } from "../../lib/hub.server";
import { env } from "cloudflare:workers";

type HubBinding = { idFromName(name: string): string; get(id: string): NexusHub };

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async () => {
        const rooms = (env as Record<string, unknown>).ROOMS as HubBinding | undefined;
        if (!rooms) {
          // Dev fallback: keep-alive comments so EventSource stays connected;
          // store.ts also polls getSnapshot ~every 12s for Supabase truth.
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode(`: cortex-dev\n\n`));
              const t = setInterval(() => {
                try {
                  controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`));
                } catch {
                  clearInterval(t);
                }
              }, 15_000);
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "x-accel-buffering": "no",
            },
          });
        }
        const id = rooms.idFromName("nexus");
        const stub = rooms.get(id);
        const upstream = await stub.fetch(new Request("https://hub/subscribe", { headers: { accept: "text/event-stream" } }));
        return new Response(upstream.body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});

// Server-Sent Events stream proxied through the NexusHub Durable Object.
// The chat UI subscribes here for live node-glow, new leads, and chat replies.
// In dev without the durableObject flag, the hub is absent and the client falls
// back to refetch-on-mutation (the app still works, just without cross-tab live push).
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
          // Dev fallback: an empty stream that just stays open.
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`: dev\n\n`));
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
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

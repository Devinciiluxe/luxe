// SERVER-ONLY: the live-event Durable Object. Kept in a dedicated .server.ts
// module because TanStack's import-protection will fail the build if a client
// import graph (routes -> cortex.ts) reaches a .server file — so cortex.ts
// NEVER imports this module. server.ts + the /api/events route import it instead.
import { DurableObject } from "cloudflare:workers";
import { bindings } from "./bindings.server";
import type { LiveFrame } from "./types";

type Writer = WritableStreamDefaultWriter<Uint8Array>;

export class NexusHub extends DurableObject {
  private streams: Set<Writer> = new Set();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      this.streams.add(writer);
      const drop = () => {
        this.streams.delete(writer);
        void writer.close().catch(() => {});
      };
      try {
        request.signal?.addEventListener?.("abort", drop);
      } catch {
        /* signal not available on all runtimes */
      }
      const enc = new TextEncoder();
      const iv = setInterval(() => {
        void writer.write(enc.encode(`: ping\n\n`)).catch(() => {
          clearInterval(iv);
          drop();
        });
      }, 20000);
      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    }
    if (url.pathname === "/push") {
      const data = await request.text();
      const enc = new TextEncoder();
      const payload = enc.encode(`data: ${data}\n\n`);
      const dead: Writer[] = [];
      for (const w of this.streams) {
        try {
          await w.write(payload);
        } catch {
          dead.push(w);
        }
      }
      for (const w of dead) this.streams.delete(w);
      return Response.json({ ok: true, delivered: this.streams.size });
    }
    return new Response("nexus hub", { status: 200 });
  }
}

/** Push a live frame to the hub. Best-effort: never throws into the request path. */
export async function broadcastToHub(frame: LiveFrame): Promise<void> {
  const b = bindings();
  if (!b.ROOMS) return;
  try {
    const id = b.ROOMS.idFromName("nexus");
    const stub = b.ROOMS.get(id);
    await stub.fetch("https://hub/push", { method: "POST", body: JSON.stringify(frame) });
  } catch {
    /* live push is best-effort; state is already durable in D1 */
  }
}

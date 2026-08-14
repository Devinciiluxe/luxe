// SERVER-ONLY broadcast facade. Both hub.server.ts (the Durable Object) and
// cortex.ts (the server functions cortex exposes to the browser) dispatch live
// frames through here. Kept as its own .server.ts module so the client import
// of cortex.ts never reaches cloudflare:workers on the import chain.
import { bindings } from "./bindings.server";
import type { LiveFrame } from "./types";

type PushFn = (frame: LiveFrame) => Promise<void>;

/**
 * Fan a live frame out to every open tab through the NexusHub Durable Object.
 * Best-effort: if the DO isn't provisioned (e.g. in `bun dev` without the
 * durableObject flag) the function resolves silently — the app still works via
 * refetch-on-mutation and the client-side SSE fallback.
 */
export const pushFrame: PushFn = async (frame) => {
  const b = bindings();
  if (!b.ROOMS) return;
  try {
    const id = b.ROOMS.idFromName("nexus");
    const stub = b.ROOMS.get(id);
    await stub.fetch("https://hub/push", { method: "POST", body: JSON.stringify(frame) });
  } catch {
    /* live push is best-effort; durable state is already in D1 */
  }
};

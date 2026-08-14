// The workerd runtime provides the `cloudflare:workers` module at runtime (the
// bundler keeps it external — see vite.config.ts). Declare it so `tsc` resolves
// the import; typed binding access is centralized in src/lib/bindings.server.ts.
declare module "cloudflare:workers" {
  export const env: unknown;

  /** Durable Object base class. Runtime: workerd provides it.
   *  Type-level: minimal surface needed by this app (fetch handler pattern). */
  class DurableObject {
    constructor(state: unknown, env: unknown);
    fetch?(request: Request): Promise<Response> | Response;
  }
}

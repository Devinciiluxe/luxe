// Server route for the owner PIN — sets the signed session cookie.
import { createFileRoute } from "@tanstack/react-router";
import { sessionCookieHeader, verifyPin, createSession } from "../../lib/auth.server";

export const Route = createFileRoute("/api/pin")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let pin = "";
        try {
          const body = (await request.json()) as { pin?: unknown };
          pin = typeof body.pin === "string" ? body.pin : "";
        } catch {
          return Response.json({ ok: false }, { status: 400 });
        }
        if (!(await verifyPin(pin))) {
          return Response.json({ ok: false }, { status: 401 });
        }
        const session = await createSession();
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": sessionCookieHeader(session),
          },
        });
      },
    },
  },
});

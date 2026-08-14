// Streams a proposal markdown doc out of R2 as a downloadable artifact.
import { createFileRoute } from "@tanstack/react-router";
import { readProposalDoc } from "../../lib/jarvis.server";

export const Route = createFileRoute("/api/proposals/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const doc = await readProposalDoc(params.id);
        if (!doc) return new Response("Not found", { status: 404 });
        return new Response(doc.body, {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `inline; filename="${doc.title.replace(/[^a-z0-9]+/gi, "-")}.md"`,
          },
        });
      },
    },
  },
});

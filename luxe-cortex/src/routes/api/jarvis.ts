// Machine-to-machine API for the JARVIS voice assistant to read and drive the
// Cortex sales pipeline. Auth: static bearer key (JARVIS_API_KEY env var),
// separate from the owner PIN cookie flow used by the dashboard UI.
import { createFileRoute } from "@tanstack/react-router";
import {
  allLeads,
  bumpLeadScore,
  computeMetrics,
  getLead,
  insertEvent,
  insertMessage,
  recentEvents,
  setLeadStage,
} from "../../lib/db.server";
import {
  composeReply,
  generateProposalDoc,
  pauseAutomation,
  runHunterSweep,
  bookSlot,
} from "../../lib/jarvis.server";
import { pushFrame } from "../../lib/broadcast.server";
import { isStage } from "../../lib/types";
import { bindings } from "../../lib/bindings.server";

function authorized(request: Request): boolean {
  const key = bindings().JARVIS_API_KEY;
  if (!key) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${key}`;
}

function unauthorized() {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export const Route = createFileRoute("/api/jarvis")({
  server: {
    handlers: {
      // GET /api/jarvis                -> pipeline snapshot (leads, events, metrics)
      // GET /api/jarvis?leadId=lead-1  -> single lead
      GET: async ({ request }) => {
        if (!authorized(request)) return unauthorized();
        const url = new URL(request.url);
        const leadId = url.searchParams.get("leadId");
        if (leadId) {
          const lead = await getLead(leadId);
          if (!lead) return Response.json({ ok: false, error: "not found" }, { status: 404 });
          return Response.json({ ok: true, lead });
        }
        const [leads, events, metrics] = await Promise.all([allLeads(), recentEvents(20), computeMetrics()]);
        return Response.json({ ok: true, leads, events, metrics });
      },

      // POST /api/jarvis  { action: "...", ...args }
      POST: async ({ request }) => {
        if (!authorized(request)) return unauthorized();
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "bad json" }, { status: 400 });
        }
        const action = body?.action;

        try {
          switch (action) {
            case "set_stage": {
              const { leadId, stage } = body;
              if (!leadId || !isStage(stage)) return Response.json({ ok: false, error: "bad args" }, { status: 400 });
              await setLeadStage(leadId, stage);
              const lead = await getLead(leadId);
              if (lead) {
                await insertEvent({
                  kind: "stage",
                  icon: stage === "no_show" || stage === "lost" ? "warn" : "check",
                  text: `${lead.company} moved to ${stage.replace("_", " ")} (via JARVIS)`,
                  datum: String(lead.score),
                });
              }
              await pushFrame({ type: "node", leadId, stage });
              await pushFrame({ type: "metrics", metrics: await computeMetrics() });
              return Response.json({ ok: true, lead });
            }

            case "run_hunter": {
              const { lead, event } = await runHunterSweep();
              return Response.json({ ok: true, lead, event });
            }

            case "toggle_automation": {
              const { which, on } = body;
              if (which !== "hunter" && which !== "outreach") {
                return Response.json({ ok: false, error: "bad which" }, { status: 400 });
              }
              await pauseAutomation(which, !!on);
              return Response.json({ ok: true });
            }

            case "compose_reply": {
              const { leadId, text } = body;
              const lead = await getLead(leadId);
              if (!lead) return Response.json({ ok: false, error: "unknown lead" }, { status: 404 });
              const userMsg = await insertMessage({
                id: `m-${crypto.randomUUID().slice(0, 10)}`,
                leadId: lead.id,
                role: "user",
                kind: "chat",
                body: text,
                badge: null,
              });
              await pushFrame({ type: "message", msg: userMsg, lead: { id: lead.id, name: lead.name, company: lead.company, score: lead.score } });
              const reply = await composeReply(lead, text);
              return Response.json({ ok: true, userMsg, reply });
            }

            case "make_proposal": {
              const { leadId } = body;
              const lead = await getLead(leadId);
              if (!lead) return Response.json({ ok: false, error: "unknown lead" }, { status: 404 });
              const doc = await generateProposalDoc(lead);
              await insertEvent({
                kind: "metric",
                icon: "check",
                text: `Proposal staged for ${lead.company} (via JARVIS)`,
                datum: String(Math.round(lead.value / 100)),
              });
              return Response.json({ ok: true, doc });
            }

            case "book_slot": {
              const { leadId, startTs } = body;
              const res = await bookSlot(leadId, startTs);
              if ("error" in res) return Response.json({ ok: false, error: res.error }, { status: 400 });
              return Response.json({ ok: true, ...res });
            }

            case "mark_no_show": {
              const { leadId } = body;
              await setLeadStage(leadId, "no_show");
              await insertEvent({ kind: "alert", icon: "warn", text: `Marked ${leadId} as no-show (via JARVIS)`, datum: "-" });
              await pushFrame({ type: "node", leadId, stage: "no_show" });
              await pushFrame({ type: "metrics", metrics: await computeMetrics() });
              return Response.json({ ok: true });
            }

            case "bump_score": {
              const { leadId, delta } = body;
              const score = await bumpLeadScore(leadId, delta ?? 1);
              return Response.json({ ok: true, score });
            }

            default:
              return Response.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
          }
        } catch (e: any) {
          return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
        }
      },
    },
  },
});

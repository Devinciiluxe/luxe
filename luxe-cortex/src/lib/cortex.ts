// Server functions = the "edge functions" of the app. Every dashboard action
// (chat send, node glow trigger, hunter sweep, stage move, pause/resume) goes
// through one of these. They run on the Worker (or Node in `bun dev`) and are
// the only code path that touches D1/R2.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  allLeads,
  bumpLeadScore,
  computeMetrics,
  getLead,
  insertEvent,
  insertMessage,
  leadMessages,
  nowSec,
  recentEvents,
  recentMessages,
  setLeadStage,
  setSetting,
} from "./db.server";
import {
  composeReply,
  generateProposalDoc,
  pauseAutomation,
  runHunterSweep,
  readProposalDoc,
  setBroadcaster,
} from "./jarvis.server";
import { pushFrame } from "./broadcast.server";
import type { LiveFrame, Snapshot } from "./types";
import { isStage } from "./types";

// Register the broadcaster once per isolate — frames fan out to every open tab
// via the NexusHub Durable Object (see src/lib/hub.server.ts).
let broadcastReady = false;
function ensureBroadcast() {
  if (!broadcastReady) {
    broadcastReady = true;
    setBroadcaster(async (frame) => {
      await pushFrame(frame as LiveFrame);
    });
  }
}

// ------- Server functions (queries) -------

export const getSnapshot = createServerFn({ method: "GET" }).handler(async (): Promise<Snapshot> => {
  ensureBroadcast();
  const [leads, events, metrics] = await Promise.all([allLeads(), recentEvents(30), computeMetrics()]);
  return { leads, events, metrics, activeLeadId: leads[0]?.id ?? null };
});

export const getLeadThread = createServerFn({ method: "GET" })
  .validator(z.object({ leadId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const [lead, msgs] = await Promise.all([getLead(data.leadId), leadMessages(data.leadId)]);
    return { lead, msgs };
  });

export const getLiveFeed = createServerFn({ method: "GET" }).handler(async () => {
  const [events, msgs] = await Promise.all([recentEvents(30), recentMessages(20)]);
  return { events, msgs };
});

export const getProposal = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    const doc = await readProposalDoc(data.id);
    if (!doc) throw new Error("Proposal not found");
    return doc;
  });

// ------- Server functions (mutations) -------

export const sendChat = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1), text: z.string().min(1).max(2000) }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    const lead = await getLead(data.leadId);
    if (!lead) throw new Error("Unknown lead");

    const userMsg = await insertMessage({
      id: `m-${crypto.randomUUID().slice(0, 10)}`,
      leadId: lead.id,
      role: "user",
      kind: "chat",
      body: data.text,
      badge: null,
    });
    await pushFrame({ type: "message", msg: userMsg, lead: { id: lead.id, name: lead.name, company: lead.company, score: lead.score } });

    // Jarvis replies — slightly delayed so the UI shows a "typing" beat on the client.
    const reply = await composeReply(lead, data.text);
    return { userMsg, reply };
  });

export const sendAutomationReply = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1) }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    const lead = await getLead(data.leadId);
    if (!lead) throw new Error("Unknown lead");
    const nudges = [
      "Checking in on the thread; I can hold tomorrow 10:20 or Thursday 14:00 for a quick working call.",
      "Circling back: the one-page rollout outline is ready whenever you want to look at it.",
      "Following up: latest scrape for this segment found a strong fit pattern. Want the summary?",
    ];
    const body = nudges[Math.floor(Math.random() * nudges.length)];
    const msg = await insertMessage({
      id: `m-${crypto.randomUUID().slice(0, 10)}`,
      leadId: lead.id,
      role: "jarvis",
      kind: "automation",
      body,
      badge: "ACTIVE",
    });
    const score = await bumpLeadScore(lead.id, 1);
    await insertEvent({ kind: "reply", icon: "check", text: `Automation reply sent on ${lead.company}`, datum: String(score) });
    await pushFrame({ type: "message", msg, lead: { id: lead.id, name: lead.name, company: lead.company, score } });
    await pushFrame({ type: "metrics", metrics: await computeMetrics() });
    return { msg };
  });

export const focusNode = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1) }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    const lead = await getLead(data.leadId);
    if (!lead) throw new Error("Unknown lead");
    const event = await insertEvent({
      kind: "system",
      icon: "check",
      text: `Node ${lead.company} activated on the cortex map`,
      datum: String(lead.score),
    });
    await pushFrame({ type: "node", leadId: lead.id, stage: lead.stage, score: lead.score });
    await pushFrame({ type: "event", event });
    return { lead, event };
  });

export const setLeadStageFn = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1), stage: z.string() }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    if (!isStage(data.stage)) throw new Error(`Unknown stage ${data.stage}`);
    await setLeadStage(data.leadId, data.stage);
    const lead = await getLead(data.leadId);
    if (lead) {
      await insertEvent({
        kind: "stage",
        icon: data.stage === "no_show" || data.stage === "lost" ? "warn" : "check",
        text: `${lead.company} moved to ${data.stage.replace("_", " ")}`,
        datum: String(lead.score),
      });
    }
    await pushFrame({ type: "node", leadId: data.leadId, stage: data.stage });
    await pushFrame({ type: "metrics", metrics: await computeMetrics() });
    return { ok: true };
  });

export const toggleAutomation = createServerFn({ method: "POST" })
  .validator(z.object({ which: z.enum(["hunter", "outreach"]), on: z.boolean() }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    await pauseAutomation(data.which, data.on);
    return { ok: true };
  });

export const runHunter = createServerFn({ method: "POST" })
  .validator(z.object({}).partial().optional())
  .handler(async () => {
    ensureBroadcast();
    const { lead } = await runHunterSweep();
    return { lead };
  });

export const markNoShow = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1) }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    await setLeadStage(data.leadId, "no_show");
    await insertEvent({
      kind: "alert",
      icon: "warn",
      text: `Marked ${data.leadId} as no-show, rescue sequence queued`,
      datum: "-",
    });
    await pushFrame({ type: "node", leadId: data.leadId, stage: "no_show" });
    await pushFrame({ type: "metrics", metrics: await computeMetrics() });
    return { ok: true };
  });

export const makeProposal = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1) }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    const lead = await getLead(data.leadId);
    if (!lead) throw new Error("Unknown lead");
    const doc = await generateProposalDoc(lead);
    await insertEvent({
      kind: "metric",
      icon: "check",
      text: `Proposal staged for ${lead.company}`,
      datum: String(Math.round(lead.value / 100)),
    });
    return { doc };
  });

/* ---------------- booking ---------------- */

export const bookSlotFn = createServerFn({ method: "POST" })
  .validator(z.object({ leadId: z.string().min(1), startTs: z.number().int().positive() }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    const { bookSlot } = await import("./jarvis.server");
    const res = await bookSlot(data.leadId, data.startTs);
    if ("error" in res) throw new Error(res.error);
    return res;
  });

export const getBookings = createServerFn({ method: "GET" }).handler(async () => {
  const { upcomingMeetings } = await import("./db.server");
  return upcomingMeetings();
});

export const cancelBookingFn = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    ensureBroadcast();
    const { cancelMeeting, insertEvent } = await import("./db.server");
    await cancelMeeting(data.id);
    await insertEvent({ kind: "alert", icon: "warn", text: `Meeting ${data.id} canceled`, datum: "CXL" });
    await pushFrame({ type: "metrics", metrics: await computeMetrics() });
    return { ok: true };
  });

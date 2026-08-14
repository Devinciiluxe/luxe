// The automation engine. Composes Jarvis replies, runs the Hunter scrape cycle,
// and produces proposal docs. Every mutation also logs a feed event — the hub
// in cortex.ts is what pushes the live frame to every open tab.
import {
  availableSlots,
  bookMeeting,
  bumpLeadScore,
  createScrapedLead,
  findMeetingByStart,
  getLead,
  hasOverlap,
  insertEvent,
  insertMessage,
  nowSec,
  setLeadStage,
  setSetting,
  computeMetrics,
} from "./db.server";
import { bindings } from "./bindings.server";
import type { Lead, LogEvent, Msg, Slot } from "./types";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 10)}`;
}

// Broadcast channel — set by cortex.ts so live frames fan out from ONE place.
export type Broadcaster = (frame:
  | { type: "event"; event: LogEvent }
  | { type: "message"; msg: Msg; lead: Pick<Lead, "id" | "name" | "company" | "score"> }
  | { type: "node"; leadId: string; stage?: string; score?: number }
  | { type: "metrics"; metrics: Awaited<ReturnType<typeof computeMetrics>> }
  | { type: "newLead"; lead: Lead }) => void | Promise<void>;

let broadcast: Broadcaster | null = null;
export function setBroadcaster(fn: Broadcaster) {
  broadcast = fn;
}

async function emit(frame: Parameters<Broadcaster>[0]) {
  try {
    await broadcast?.(frame);
  } catch {
    // live push is best-effort; the state itself is already durable in D1
  }
}

const OPENERS = [
  "Logged. I am routing this to the active node and will have a follow-up in the thread shortly.",
  "Received. Scoring the account and lining up the next action now.",
  "On it. I will draft the next touch and keep this thread warm.",
  "Noted. Queuing an automation pass for this node.",
  "Captured. I am folding this into the outreach plan for this account.",
];

const INTENT_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(price|pricing|cost|rate|quote|budget)\b/i, "PRICING"],
  [/\b(call|meeting|book|schedule|demo|friday|monday|tuesday|wednesday|thursday|am|pm)\b/i, "BOOKING"],
  [/\b(no.?show|skip|ghost|cancel)\b/i, "NO_SHOW"],
  [/\b(report|summary|metrics|numbers|pipeline)\b/i, "REPORT"],
  [/\b(proposal|deck|quote|estimate)\b/i, "PROPOSAL"],
  [/\b(start|begin|kick.?off|launch|onboard)\b/i, "ONBOARD"],
  [/\b(wholesale|franchise|multi.?site|depot|locations)\b/i, "MULTI"],
];

function detectIntent(text: string): { tag: string; label: string } {
  for (const [re, tag] of INTENT_KEYWORDS) if (re.test(text)) {
    const label = {
      PRICING: "pricing",
      BOOKING: "booking",
      NO_SHOW: "no-show risk",
      REPORT: "report",
      PROPOSAL: "proposal",
      ONBOARD: "onboarding",
      MULTI: "multi-site growth",
    }[tag]!;
    return { tag, label };
  }
  return { tag: "GENERIC", label: "the account" };
}

// Composes the reply, updates score/stage, may stage a proposal doc in R2.
export async function composeReply(lead: Lead, userText: string): Promise<Msg> {
  const { tag, label } = detectIntent(userText);
  const first = lead.name.split(" ")[0];

  let body = "";
  let badge: string | null = "ACTIVE";
  let stage: typeof lead.stage | null = null;
  let scoreDelta = 1;

  switch (tag) {
    case "PRICING":
      body = `${first}, I dropped a pricing matrix into this thread; rough band is $${(lead.value / 100 / 1000).toFixed(0)}k per quarter for this scope. Full breakdown is saved as a doc.`;
      badge = "DOC_READY";
      scoreDelta = 4;
      break;
    case "BOOKING": {
      const slots = await availableSlots(lead.id);
      const open = slots.filter((s) => !s.taken);
      if (open.length > 0) {
        body = `I can lock this in. Three live slots for ${first}:`;
        badge = "SCHEDULE";
        stage = "replied";
      } else {
        body = `Your calendar's wide open this week, but Jarvis is holding for the next few hours. Tell me what day works and I'll lock it.`;
        badge = "ACTIVE";
        stage = "replied";
      }
      // Attach the slots to the message body so the chat UI can render buttons.
      // We re-encode as a null-delimited suffix that the UI splits back off.
      if (open.length > 0) {
        body = `${body}\n__SLOTS__${JSON.stringify(open.map((s) => ({ ts: s.ts, label: s.label, taken: s.taken })))}`;
      }
      scoreDelta = 3;
      break;
    }
    case "NO_SHOW":
      body = `Got it. I am moving this account into a 3-step rescue sequence: same-day nudge, 48h channel switch, one voice note. If it stalls after that, it drops to Lost and stops costing you sends.`;
      badge = "AUTOMATION";
      stage = "outreach_sent";
      scoreDelta = -6;
      break;
    case "REPORT":
      body = `Compiling the account report for ${lead.company}: reply rate, moves this week, and where it sits on the map. Link follows in thread.`;
      badge = "DOC_READY";
      scoreDelta = 2;
      break;
    case "PROPOSAL":
      body = `Drafting the proposal for ${lead.company} now; it saves to Docs in about 20 seconds and lands back in this thread.`;
      badge = "DOC_READY";
      stage = "qualified";
      scoreDelta = 5;
      break;
    case "ONBOARD":
      body = `Perfect. I am starting the 10-day onboarding map for ${lead.company}: intake, kickoff, then two live checkpoints. Staging the kickoff pack now.`;
      badge = "ONBOARDING";
      stage = "won";
      scoreDelta = 6;
      break;
    case "MULTI":
      body = `Read. I am splitting ${lead.company} into per-location sub-threads so no site waits on another. The map will reflect each one as its own node.`;
      badge = "ACTIVE";
      stage = "qualified";
      scoreDelta = 2;
      break;
    default:
      body = OPENERS[Math.floor(Math.random() * OPENERS.length)];
      badge = "ACTIVE";
      scoreDelta = 1;
  }

  const msg = await insertMessage({
    id: uid("m"),
    leadId: lead.id,
    role: "jarvis",
    kind: "automation",
    body,
    badge,
  });

  if (stage) await setLeadStage(lead.id, stage);
  const newScore = await bumpLeadScore(lead.id, scoreDelta);
  await emit({ type: "message", msg, lead: { id: lead.id, name: lead.name, company: lead.company, score: newScore } });
  await emit({ type: "node", leadId: lead.id, stage: stage ?? lead.stage, score: newScore });
  await emit({ type: "metrics", metrics: await computeMetrics() });

  return msg;
}

export async function runHunterSweep(): Promise<{ lead: Lead; event: LogEvent }> {
  const lead = await createScrapedLead("hunter");
  const fit = 12 + Math.floor(Math.random() * 40);
  const event = await insertEvent({
    kind: "scrape",
    icon: "lead",
    text: `Hunter: ${fit} fit profiles surfaced ${lead.company} as a new node`,
    datum: String(fit),
  });
  await insertMessage({
    id: uid("m"),
    leadId: lead.id,
    role: "jarvis",
    kind: "automation",
    body: `Hunter sweep: ${fit} public profiles indexed around ${lead.company}. Added as a pending-outreach node at score ${lead.score}.`,
    badge: "SCRAPED",
  });
  await emit({ type: "newLead", lead });
  await emit({ type: "event", event });
  await emit({ type: "metrics", metrics: await computeMetrics() });
  return { lead, event };
}

export async function pauseAutomation(which: "hunter" | "outreach", on: boolean) {
  await setSetting(which === "hunter" ? "hunter_running" : "outreach_running", on ? "1" : "0");
  const event = await insertEvent({
    kind: "system",
    icon: on ? "check" : "warn",
    text: `${which === "hunter" ? "Lead Hunter" : "Outbound engine"} ${on ? "resumed" : "paused"} from the command bar`,
    datum: on ? "RUN" : "HOLD",
  });
  await emit({ type: "event", event });
  await emit({ type: "metrics", metrics: await computeMetrics() });
}

export async function generateProposalDoc(lead: Pick<Lead, "id" | "name" | "company" | "value">): Promise<{ id: string; title: string; url: string }> {
  const body = `# ${lead.company} — Growth Proposal\n\nPrepared by JARVIS for ${lead.name}.\n\n## Scope\n- Automated intake + reminder chain\n- Outbound Lead Hunter sweep\n- Weekly pipeline review\n\n## Estimated value\n$${(lead.value / 100).toLocaleString("en-US")} qualified pipeline over the first quarter.\n\n## Next step\nReply in the Cortex thread to lock the kickoff call.\n`;
  const key = `proposals/${lead.id}/${Date.now()}.md`;
  const b = bindings();
  if (b.STORAGE) {
    await b.STORAGE.put(key, body, { httpMetadata: { contentType: "text/markdown" } });
  }
  const id = uid("doc");
  await (bindings().DB!)
    .prepare("INSERT INTO proposals (id, lead_id, title, storage_key) VALUES (?,?,?,?)")
    .bind(id, lead.id, `${lead.company} — Growth Proposal`, key)
    .run();
  return { id, title: `${lead.company} — Growth Proposal`, url: `/api/proposals/${id}` };
}

export async function bookSlot(leadId: string, startTs: number): Promise<{ slot: Slot; meeting: { id: string } } | { error: string }> {
  const lead = await getLead(leadId);
  if (!lead) return { error: "Unknown lead" };
  const existing = await findMeetingByStart(leadId, startTs);
  if (existing) return { error: "Already booked at that time" };
  if (await hasOverlap(leadId, startTs, 30)) return { error: "Overlaps another booking for this lead" };

  const id = uid("mt");
  await bookMeeting(id, leadId, startTs, 30, `Booked from chat — ${lead.name}`);
  await bumpLeadScore(leadId, 8);
  await insertEvent({
    kind: "reply",
    icon: "check",
    text: `${lead.company} booked a meeting for ${new Date(startTs * 1000).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
    datum: "BOOKED",
  });
  const msg = await insertMessage({
    id: uid("m"),
    leadId,
    role: "jarvis",
    kind: "automation",
    body: `Locked. Meeting booked for ${new Date(startTs * 1000).toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Confirmation + reminder chain armed.`,
    badge: "BOOKED",
  });
  await emit({ type: "message", msg, lead: { id: lead.id, name: lead.name, company: lead.company, score: lead.score } });
  await emit({ type: "metrics", metrics: await computeMetrics() });
  return { slot: { ts: startTs, label: "", taken: true }, meeting: { id } };
}

export async function readProposalDoc(id: string): Promise<{ title: string; body: string } | null> {
  const d = bindings().DB!;
  const row = await d.prepare("SELECT title, storage_key FROM proposals WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const b = bindings();
  const obj = b.STORAGE ? await b.STORAGE.get(row.storage_key as string) : null;
  const body = obj ? await obj.text() : "";
  return { title: row.title as string, body };
}

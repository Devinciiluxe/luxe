// Pure UI/event types shared by the SSR shell, the client store, and the 3D scene.
export type Stage =
  | "pending_outreach"
  | "outreach_sent"
  | "replied"
  | "qualified"
  | "won"
  | "lost"
  | "no_show";

export interface Lead {
  id: string;
  name: string;
  company: string;
  handle: string | null;
  email: string | null;
  channel: string;
  stage: Stage;
  value: number; // USD cents
  score: number; // 0-100
  tags: string[];
  n: [number, number, number]; // brain-map position
  updatedAt: number;
}

export interface Msg {
  id: string;
  leadId: string;
  role: "user" | "jarvis" | "lead" | "system";
  kind: "chat" | "automation" | "note";
  body: string;
  badge: string | null;
  /** Present on Jarvis SCHEDULE messages: the 2-3 clickable slots offered. */
  slots?: Slot[];
  createdAt: number;
}

export interface Slot {
  ts: number;         // unix start
  label: string;      // "Tue 10:20" style
  taken: boolean;
}

export interface Meeting {
  id: string;
  leadId: string;
  startTs: number;
  durationMin: number;
  status: "confirmed" | "canceled" | "done" | "no_show";
  notes: string | null;
  createdAt: number;
}

export interface LogEvent {
  id: number;
  kind: string;
  icon: "check" | "warn" | "lead";
  text: string;
  datum: string | null;
  createdAt: number;
}

export interface Metrics {
  activeNodes: number;
  pipelineCents: number;
  pendingReplies: number;
  pendingOutreach: number;
  pendingSends: number;
  won: number;
  noShows: number;
  /** Derived from Supabase lead counts — not host CPU. Label as HUD dial in UI. */
  replyRate: number; // 0-1 from live lead stages
  loadPct: number;
  throttlePct: number; // settings.throttle_pct in Supabase
  hunterRunning: boolean;
  outreachRunning: boolean;
  autoReply: boolean;
}

export interface Snapshot {
  leads: Lead[];
  events: LogEvent[];
  /** Null when Supabase is unreachable — never fabricate demo metrics. */
  metrics: Metrics | null;
  activeLeadId: string | null;
  /** Set when the snapshot could not be loaded from Supabase. */
  error?: string | null;
}

// Live frames pushed over SSE to all open tabs.
export type LiveFrame =
  | { type: "node"; leadId: string; stage?: Stage; score?: number }
  | { type: "event"; event: LogEvent }
  | { type: "message"; msg: Msg; lead: Pick<Lead, "id" | "name" | "company" | "score"> }
  | { type: "metrics"; metrics: Metrics }
  | { type: "newLead"; lead: Lead };

export const STAGE_LABEL: Record<Stage, string> = {
  pending_outreach: "Pending outreach",
  outreach_sent: "Outreach sent",
  replied: "Replied",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
  no_show: "No-show",
};

export const STAGES: Stage[] = [
  "pending_outreach",
  "outreach_sent",
  "replied",
  "qualified",
  "won",
  "lost",
  "no_show",
];

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as string[]).includes(v);
}

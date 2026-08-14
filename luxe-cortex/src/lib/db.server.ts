// Server-only data access. Every function re-reads bindings (fresh per request),
// so the same code runs against D1 on the platform and the local sqlite in dev.
import { bindings } from "./bindings.server";
import type { Lead, LogEvent, Metrics, Msg, Stage } from "./types";

type Row = Record<string, unknown>;
type D1 = ReturnType<NonNullable<ReturnType<typeof bindings>["DB"] extends infer T ? () => T : never>> extends never ? never : NonNullable<ReturnType<typeof bindings>["DB"]>;

// resolve returns the D1 handle, running the self-initializer on first access
// (the platform CI doesn't execute migrations; migrate.server.ts does it inline).
async function resolve(): Promise<D1> {
  const b = bindings();
  if (!b.DB) throw new Error("D1 binding DB is not provisioned (see app.manifest.json)");
  // Local import cycle guard: migrate.server imports bindings only.
  const { ensureMigrated } = await import("./migrate.server");
  await ensureMigrated();
  return b.DB as D1;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Settings live in Supabase alongside leads/messages/activity. They used to run
// on local D1, which meant the dashboard and the VM worker read two different
// stores — a key written by one (e.g. airbnb_credentials) was invisible to the
// other, and jobs failed with "no airbnb_credentials in settings table".

export async function getSetting(key: string, fallback: string): Promise<string> {
  const res = await supabaseFetch(`settings?key=eq.${encodeURIComponent(key)}&select=value`);
  if (!res.ok) throw new Error(`Supabase getSetting(${key}) failed: ${res.status}`);
  const rows = (await res.json()) as Array<{ value?: string }>;
  return rows[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  // `key` is the primary key, so merge-duplicates gives us INSERT .. ON CONFLICT.
  await supabaseWrite(
    "settings",
    "POST",
    { key, value, updated_at: new Date().toISOString() },
    { upsert: true },
  );
}




// ---- Real leads live in Supabase (the actual pipeline, 5,000+ rows) — the
// node map reads them live from there instead of a locally-synced copy, so
// there's exactly one source of truth. Local D1 `leads` stays unused now;
// messages/events/settings are unaffected and still run on D1. ----

const SUPABASE_STAGE_MAP: Record<string, Stage> = {
  new: "pending_outreach",
  contacted: "outreach_sent",
  replied: "replied",
  qualified: "qualified",
  call_booked: "qualified",
  closed: "won",
  escalated: "qualified",
  lost: "lost",
};

type SupabaseLeadRow = {
  id: string;
  first_name?: string; last_name?: string; email?: string;
  company?: string; property_name?: string;
  list_price?: number; nightly_rate?: number; bedrooms?: number;
  lead_score?: number; status?: string; source_platform?: string;
  updated_at?: string;
};

function hashPos(seed: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const x = ((h % 2000) / 1000) - 1;
  const y = (((h >>> 8) % 2000) / 1000) - 1;
  const z = (((h >>> 16) % 2000) / 1000) - 1;
  return [x, y, z];
}

// What LUXE charges to produce the flythrough film for this listing.
//
// Three tiers by bedroom count set the base. If the host charges more per night
// than their tier price, the film matches their nightly rate instead — the film
// is never cheaper than one night's stay at the property.
//
//   price = max(tierPrice(bedrooms), nightly_rate)
//
// Replaces `list_price || nightly_rate * 30`, which priced a month of the HOST's
// bookings at 100% occupancy instead of one film sale. 5,046 of 5,065 leads have
// list_price = 0, so that expression fell through to the nightly branch for
// 99.6% of the pipeline and reported $219,744,489 — 32x the real $6,734,977.
const TIER_1_PRICE = 1_100;   // 1-3 bedrooms
const TIER_2_PRICE = 1_800;   // 4-7 bedrooms
const TIER_3_PRICE = 2_500;   // 8+ bedrooms

// Scraped nightly rates above this are data errors — a 2-bed at $115,854/night,
// a 1-bed at $21,715. The 99th percentile of real rates is $8,284. Without this
// guard, max() turns a scrape error straight into a customer quote.
const MAX_CREDIBLE_NIGHTLY = 10_000;

// Returns 0 when the listing has not been scraped (no bedrooms or no nightly
// rate). 0 means "not priced" and must render as "—", never as a dollar figure.
function filmPriceCents(bedrooms: number | null, nightlyRate: number | null): number {
  const beds = bedrooms ?? 0;
  const nightly = nightlyRate ?? 0;
  if (beds <= 0 || nightly <= 0) return 0;
  const tier = beds >= 8 ? TIER_3_PRICE : beds >= 4 ? TIER_2_PRICE : TIER_1_PRICE;
  const credibleNightly = nightly > MAX_CREDIBLE_NIGHTLY ? 0 : nightly;
  return Math.round(Math.max(tier, credibleNightly) * 100);
}

function supabaseToLead(r: SupabaseLeadRow): Lead {
  const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Unknown";
  const company = r.company || r.property_name || "Unknown";
  const value = filmPriceCents(r.bedrooms ?? null, r.nightly_rate ?? null);
  return {
    id: `sb-${r.id}`,
    name,
    company,
    handle: null,
    email: r.email ?? null,
    channel: "outbound",
    stage: SUPABASE_STAGE_MAP[r.status ?? "new"] ?? "pending_outreach",
    value,
    score: Math.round(r.lead_score ?? 50),
    tags: r.source_platform ? [r.source_platform] : [],
    n: hashPos(r.id),
    updatedAt: r.updated_at ? Math.floor(new Date(r.updated_at).getTime() / 1000) : nowSec(),
  };
}

function supabaseConfig(): { url: string; key: string } {
  const b = bindings();
  const url = b.LUXE_SUPABASE_URL;
  const key = b.LUXE_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("LUXE_SUPABASE_URL / LUXE_SUPABASE_SERVICE_KEY not configured");
  return { url, key };
}

async function supabaseFetch(path: string): Promise<Response> {
  const { url, key } = supabaseConfig();
  return fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

/** Runaway guard for paged reads — well above the live table size, not a page cap. */
const SUPABASE_MAX_ROWS = 100_000;

/** Write helper (POST/PATCH). Returns the representation rows Supabase echoes back. */
async function supabaseWrite(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  opts: { upsert?: boolean } = {},
): Promise<Row[]> {
  const { url, key } = supabaseConfig();
  const prefer = opts.upsert
    ? "return=representation,resolution=merge-duplicates"
    : "return=representation";
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Row[];
}

/** Supabase stores timestamps as ISO text; the UI types use unix seconds. */
function toEpoch(v: unknown): number {
  if (!v) return 0;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** LogEvent.id is numeric but activity.id is a uuid — derive a stable number. */
function numericId(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** Lead ids are exposed as `sb-<uuid>`; Supabase stores the bare uuid. */
function bareLeadId(id: string): string {
  return id.startsWith("sb-") ? id.slice(3) : id;
}

// Reverse of SUPABASE_STAGE_MAP. Lossy by nature: the forward map collapses
// call_booked/escalated into "qualified", so those land back on "qualified".
// no_show has no Supabase equivalent — "escalated" is the closest (it is what
// JARVIS's mark_no_show queues a rescue sequence for).
const STAGE_TO_SUPABASE: Record<Stage, string> = {
  pending_outreach: "new",
  outreach_sent: "contacted",
  replied: "replied",
  qualified: "qualified",
  won: "closed",
  lost: "lost",
  no_show: "escalated",
};

export async function allLeads(): Promise<Lead[]> {
  const { url, key } = supabaseConfig();
  // PostgREST caps at 1000 rows per request regardless of ?limit — page with Range
  // until a short page comes back. Previously this issued two fixed Range requests
  // (0-999, 1000-1499) and silently dropped every lead past 1,500.
  // bedrooms is required by filmPriceCents() — without it every lead prices at 0.
  const cols = "id,first_name,last_name,email,company,property_name,list_price,nightly_rate,bedrooms,lead_score,status,source_platform,updated_at";
  const PAGE = 1000;
  const rows: SupabaseLeadRow[] = [];
  let from = 0;
  for (;;) {
    // `updated_at` alone is not a total order: it has ties, and setLeadStage
    // rewrites it, which would reshuffle rows between page requests and make
    // this loop skip or duplicate leads. `id` is unique and immutable.
    const res = await fetch(`${url}/rest/v1/leads?select=${cols}&order=updated_at.desc,id.asc`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`Supabase leads fetch failed: ${res.status} ${await res.text()}`);
    const page: SupabaseLeadRow[] = await res.json();
    rows.push(...page);
    // Only an empty page proves the end of the table. A short-but-non-empty page
    // means the server's own cap (PostgREST db-max-rows) is smaller than PAGE —
    // treating that as "done" is exactly how the original 1,500 truncation hid.
    if (page.length === 0) break;
    from += page.length;
    if (from >= SUPABASE_MAX_ROWS) {
      throw new Error(`allLeads exceeded ${SUPABASE_MAX_ROWS} rows — refusing to return a truncated set`);
    }
  }
  return rows.map(supabaseToLead);
}

export async function getLead(id: string): Promise<Lead | null> {
  const rawId = id.startsWith("sb-") ? id.slice(3) : id;
  const res = await supabaseFetch(`leads?id=eq.${encodeURIComponent(rawId)}&select=*`);
  // Without this, a 401/5xx body ({"code":...,"message":...}) parses to an object,
  // rows[0] is undefined, and an auth outage is indistinguishable from "no such lead".
  if (!res.ok) throw new Error(`Supabase getLead(${id}) failed: ${res.status}`);
  const rows: SupabaseLeadRow[] = await res.json();
  return rows[0] ? supabaseToLead(rows[0]) : null;
}

// ---- Messages and activity now read from Supabase, the same source of truth as
// leads. They previously ran on local D1 (`messages`, `events`), which meant the
// dashboard and JARVIS never saw the real inbox — Supabase's 571 messages and
// 9,500+ activity rows were invisible while D1 served an unrelated local copy. ----

type SupabaseMsgRow = {
  id: string; lead_id?: string; direction?: string; channel?: string;
  category?: string; body?: string; intent?: string; created_at?: string;
  meta?: string;
};

/**
 * Msg.badge is a UI label ("ACTIVE", "BOOKED", "SCRAPED"), NOT a transport.
 * messages.channel is CHECK-constrained to sms|email|platform_dm, so the two
 * must not be conflated — round-tripping badge through channel would both write
 * false provenance and turn every badge into "platform_dm" on read-back.
 * The badge and the originating role ride in `meta` instead.
 */
type MsgMeta = { badge?: string | null; role?: Msg["role"]; kind?: Msg["kind"] };

function parseMsgMeta(raw?: string): MsgMeta {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as MsgMeta) : {};
  } catch {
    return {};
  }
}

function supabaseToMsg(r: SupabaseMsgRow): Msg {
  const inbound = r.direction === "inbound";
  const meta = parseMsgMeta(r.meta);
  return {
    id: r.id,
    leadId: r.lead_id ? `sb-${r.lead_id}` : "",
    // Prefer the role we recorded; direction alone cannot tell an operator's
    // hand-typed reply ("user") apart from an automated send ("jarvis").
    role: meta.role ?? (inbound ? "lead" : "jarvis"),
    kind: meta.kind ?? (inbound ? "chat" : "automation"),
    body: r.body ?? "",
    badge: meta.badge ?? null,
    createdAt: toEpoch(r.created_at),
  };
}

type SupabaseActivityRow = {
  id: string; kind?: string; message?: string; meta?: string; created_at?: string;
};

/** activity has no icon column, so app-written events stash it in meta. */
type EventMeta = { icon?: LogEvent["icon"]; datum?: string | null };

function supabaseToEvent(r: SupabaseActivityRow): LogEvent {
  const kind = r.kind ?? "";
  const raw = r.meta ?? "";
  let meta: EventMeta = {};
  if (raw.startsWith("{")) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") meta = v as EventMeta;
    } catch {
      meta = {};
    }
  }
  // Fall back to keyword matching for pipeline-authored rows, which carry no
  // icon. "alert"/"block"/"denied" are included because the app's own warn-level
  // events use kind "alert", which the original pattern missed entirely.
  const derived: LogEvent["icon"] = /fail|error|warn|escalat|suppress|bounce|alert|block|denied|stuck/i.test(kind)
    ? "warn"
    : /lead|new|scrape/i.test(kind)
      ? "lead"
      : "check";
  // datum renders as a single-line chip. Pipeline metas are JSON blobs running to
  // hundreds of characters, which would blow the event-log layout apart.
  const rawDatum = meta.datum ?? (raw.startsWith("{") ? null : raw);
  const datum = rawDatum && rawDatum.length <= 24 ? rawDatum : null;
  return {
    id: numericId(r.id),
    kind,
    icon: meta.icon ?? derived,
    text: r.message ?? "",
    datum: datum || null,
    createdAt: toEpoch(r.created_at),
  };
}

export async function leadMessages(leadId: string): Promise<Msg[]> {
  const res = await supabaseFetch(
    `messages?lead_id=eq.${encodeURIComponent(bareLeadId(leadId))}&select=*&order=created_at.asc`,
  );
  if (!res.ok) throw new Error(`Supabase leadMessages failed: ${res.status}`);
  const rows: SupabaseMsgRow[] = await res.json();
  return rows.map(supabaseToMsg);
}

export async function recentMessages(limit = 40): Promise<Msg[]> {
  const res = await supabaseFetch(`messages?select=*&order=created_at.desc&limit=${limit}`);
  if (!res.ok) throw new Error(`Supabase recentMessages failed: ${res.status}`);
  const rows: SupabaseMsgRow[] = await res.json();
  return rows.map(supabaseToMsg);
}

export async function recentEvents(limit = 30): Promise<LogEvent[]> {
  // Supabase calls this table `activity`; D1 called it `events`.
  const res = await supabaseFetch(`activity?select=*&order=created_at.desc&limit=${limit}`);
  if (!res.ok) throw new Error(`Supabase recentEvents failed: ${res.status}`);
  const rows: SupabaseActivityRow[] = await res.json();
  return rows.map(supabaseToEvent);
}

export async function insertMessage(m: Omit<Msg, "createdAt"> & { createdAt?: number }): Promise<Msg> {
  const createdAt = m.createdAt ?? nowSec();
  // Writes follow the reads onto Supabase — a message written to D1 would never
  // appear in the dashboard or in JARVIS's view of the thread.
  const meta: MsgMeta = { badge: m.badge ?? null, role: m.role, kind: m.kind };
  const rows = await supabaseWrite("messages", "POST", {
    id: m.id,
    lead_id: bareLeadId(m.leadId),
    direction: m.role === "lead" ? "inbound" : "outbound",
    // These messages originate in-app rather than over SMS/email. Callers that
    // genuinely know the transport should set it explicitly rather than have it
    // inferred from a UI badge.
    channel: "platform_dm",
    body: m.body,
    meta: JSON.stringify(meta),
    created_at: new Date(createdAt * 1000).toISOString(),
  });
  if (rows.length !== 1) throw new Error(`insertMessage(${m.id}) wrote ${rows.length} rows`);
  return { ...m, createdAt };
}

export async function insertEvent(e: Omit<LogEvent, "id" | "createdAt"> & { createdAt?: number }): Promise<LogEvent> {
  const createdAt = e.createdAt ?? nowSec();
  // activity has no icon column — round-trip it (and the datum) through meta so a
  // warn-level event doesn't read back as a green check after a reload.
  const meta: EventMeta = { icon: e.icon, datum: e.datum ?? null };
  const rows = await supabaseWrite("activity", "POST", {
    kind: e.kind,
    message: e.text,
    meta: JSON.stringify(meta),
    created_at: new Date(createdAt * 1000).toISOString(),
  });
  const newId = String(rows[0]?.id ?? "");
  return { ...e, id: newId ? numericId(newId) : 0, createdAt };
}

export async function setLeadStage(id: string, stage: Stage): Promise<void> {
  // Leads are READ from Supabase, so the write has to land there too. This used
  // to UPDATE the unused local D1 `leads` table, which meant every stage change
  // (including JARVIS's set_stage / mark_no_show) was silently discarded.
  const status = STAGE_TO_SUPABASE[stage];
  if (!status) throw new Error(`Unknown stage: ${stage}`);
  const updated = await supabaseWrite(
    `leads?id=eq.${encodeURIComponent(bareLeadId(id))}`,
    "PATCH",
    { status, updated_at: new Date().toISOString() },
  );
  // PostgREST answers 200 + [] when the filter matches nothing, so res.ok alone
  // would let a no-op report success — the same silent discard this fix removed.
  if (updated.length !== 1) {
    throw new Error(`setLeadStage(${id}) matched ${updated.length} rows — stage not persisted`);
  }
}

/* ---------------- meetings / booking ---------------- */

export interface MeetingRow {
  id: string;
  lead_id: string;
  start_ts: number;
  duration_min: number;
  status: string;
  notes: string | null;
  created_at: number;
}

export async function upcomingMeetings(): Promise<Array<MeetingRow & { company: string; name: string }>> {
  // Meetings themselves stay in D1 (Supabase has no `meetings` table), but lead
  // identity comes from Supabase. The old query JOINed the local D1 `leads`
  // table, which is unused and empty — so this always returned zero rows and
  // the upcoming-meetings panel looked permanently empty.
  const res = await (await resolve()).prepare(
    `SELECT * FROM meetings
     WHERE status = 'confirmed' AND start_ts >= unixepoch() - 3600
     ORDER BY start_ts ASC LIMIT 50`,
  ).all<Row>();
  const rows = (res.results ?? []) as unknown as MeetingRow[];
  if (!rows.length) return [];

  const ids = [...new Set(rows.map((m) => bareLeadId(m.lead_id)))];
  const byId = new Map<string, Lead>();
  // Chunk the `in.(...)` filter so the URL stays within limits.
  for (let i = 0; i < ids.length; i += 100) {
    const list = ids.slice(i, i + 100).map((id) => `"${id}"`).join(",");
    const r = await supabaseFetch(`leads?id=in.(${encodeURIComponent(list)})&select=*`);
    if (!r.ok) throw new Error(`Supabase meeting-lead lookup failed: ${r.status}`);
    for (const row of (await r.json()) as SupabaseLeadRow[]) byId.set(row.id, supabaseToLead(row));
  }

  return rows.map((m) => {
    const lead = byId.get(bareLeadId(m.lead_id));
    return { ...m, name: lead?.name ?? "Unknown", company: lead?.company ?? "Unknown" };
  });
}

export async function meetingsForLead(leadId: string): Promise<MeetingRow[]> {
  const res = await (await resolve()).prepare("SELECT * FROM meetings WHERE lead_id = ? ORDER BY start_ts DESC LIMIT 20").bind(leadId).all<Row>();
  return (res.results ?? []) as unknown as MeetingRow[];
}

export async function findMeetingByStart(leadId: string, startTs: number): Promise<MeetingRow | null> {
  const r = await (await resolve()).prepare("SELECT * FROM meetings WHERE lead_id = ? AND start_ts = ? AND status = 'confirmed' LIMIT 1").bind(leadId, startTs).first<Row>();
  return (r as unknown as MeetingRow) ?? null;
}

export async function bookMeeting(id: string, leadId: string, startTs: number, durationMin = 30, notes?: string): Promise<MeetingRow> {
  await (await resolve()).prepare(
    "INSERT INTO meetings (id, lead_id, start_ts, duration_min, status, notes) VALUES (?,?,?,?,?,?)",
  ).bind(id, leadId, startTs, durationMin, "confirmed", notes ?? null).run();
  return { id, lead_id: leadId, start_ts: startTs, duration_min: durationMin, status: "confirmed", notes: notes ?? null, created_at: nowSec() };
}

export async function cancelMeeting(id: string): Promise<void> {
  await (await resolve()).prepare("UPDATE meetings SET status = 'canceled' WHERE id = ?").bind(id).run();
}

/** Return true when the lead already has a confirmed meeting that overlaps [start, start+dur). */
export async function hasOverlap(leadId: string, startTs: number, durationMin = 30): Promise<boolean> {
  const end = startTs + durationMin * 60;
  const r = await (await resolve()).prepare(
    "SELECT COUNT(*) AS c FROM meetings WHERE lead_id = ? AND status = 'confirmed' AND start_ts < ? AND (start_ts + duration_min*60) > ?",
  ).bind(leadId, end, startTs).first<Row>();
  return (Number(r?.c) || 0) > 0;
}

/** Up to 3 business-friendly slots over the next 3 days, avoiding existing bookings for this lead. */
export async function availableSlots(leadId: string): Promise<Array<{ ts: number; label: string; taken: boolean }>> {
  const existing = await meetingsForLead(leadId);
  const taken = new Set(existing.filter((m) => m.status === "confirmed").map((m) => m.start_ts));
  const out: Array<{ ts: number; label: string; taken: boolean }> = [];
  const now = new Date();
  const candidates = [
    { dayOffset: 1, h: 10, min: 20 },
    { dayOffset: 1, h: 14, min: 0 },
    { dayOffset: 2, h: 10, min: 20 },
    { dayOffset: 2, h: 14, min: 30 },
    { dayOffset: 3, h: 11, min: 0 },
  ];
  const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });
  for (const c of candidates) {
    if (out.length >= 3) break;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + c.dayOffset, c.h, c.min, 0, 0);
    // skip weekends
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const ts = Math.floor(d.getTime() / 1000);
    const label = `${dayFmt.format(d)} ${String(c.h).padStart(2, "0")}:${String(c.min).padStart(2, "0")}`;
    out.push({ ts, label, taken: taken.has(ts) });
  }
  return out;
}

export async function addMeetingNotes(id: string, note: string): Promise<void> {
  await (await resolve()).prepare("UPDATE meetings SET notes = ? WHERE id = ?").bind(note, id).run();
}

export async function bumpLeadScore(id: string, delta: number): Promise<number> {
  // Same defect setLeadStage had: this used to UPDATE the unused local D1 `leads`
  // table, match zero rows, then return `Number(undefined) || 0` — fabricating a
  // score of 0 that callers broadcast to clients and read aloud as fact.
  const bare = bareLeadId(id);
  const cur = await supabaseFetch(`leads?id=eq.${encodeURIComponent(bare)}&select=lead_score`);
  if (!cur.ok) throw new Error(`Supabase bumpLeadScore(${id}) read failed: ${cur.status}`);
  const curRows = (await cur.json()) as Array<{ lead_score?: number }>;
  if (curRows.length !== 1) throw new Error(`bumpLeadScore(${id}) matched ${curRows.length} leads`);

  const next = Math.max(0, Math.min(100, (curRows[0].lead_score ?? 0) + delta));
  const updated = await supabaseWrite(
    `leads?id=eq.${encodeURIComponent(bare)}`,
    "PATCH",
    { lead_score: next, updated_at: new Date().toISOString() },
  );
  if (updated.length !== 1) throw new Error(`bumpLeadScore(${id}) wrote ${updated.length} rows`);
  return next;
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1296;
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}${idCounter.toString(36)}`;
}

const FIRST = ["Iris","Noel","Sana","Owen","Maya","Jonas","Petra","Ravi","Alba","Marcus","Lena","Theo","Dina","Carlos","June","Felix","Aria","Bram","Nia","Silas"];
const LAST = ["Okafor","Reyes","Lindgren","Kaur","Meyer","Sato","Dubois","Novak","Costa","Ali","Beaumont","Fischer","Petrov","Nakamura","Iversen","Moreau","Halloran","Osei","Brandt","Vasquez"];
const COMPANY_PRE = ["Atlas","Beacon","Harbor","Juniper","Copper","Summit","Signal","North","Vector","Ember","Granite","Cobalt","Willow","Meridian","Anchor","Ironclad","Foxglove","Hearth","Lakeside"];
const COMPANY_SUF = ["Logistics","Dental","Legal","Media","Solar","Fitness","Realty","Coffee","Security","Games","Vet","Travel","Auto","Events","Beauty","Market","Trucking","Plumbing","Roofing","Chiro"];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

export async function createScrapedLead(source = "hunter"): Promise<Lead> {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const company = `${pick(COMPANY_PRE)} ${pick(COMPANY_SUF)}`;
  const value = (30 + Math.floor(Math.random() * 420)) * 1000;
  const score = 35 + Math.floor(Math.random() * 55);
  const side = Math.random() < 0.5 ? -1 : 1;
  const theta = Math.random() * Math.PI * 2;
  const rr = 0.35 + Math.random() * 0.3;
  const nx = side * (0.08 + rr * Math.abs(Math.cos(theta)) * 0.9);
  const ny = Math.max(-0.55, Math.min(0.6, rr * Math.sin(theta)));
  const nz = (Math.random() - 0.5) * 1.1;
  const id = genId("ld");
  const lead: Lead = {
    id, name, company,
    handle: `@${name.toLowerCase().replace(/\s+/g, "")}`,
    email: `${name.toLowerCase().split(" ")[0]}@${company.toLowerCase().replace(/\s+/g, "")}.com`,
    channel: source, stage: "pending_outreach", value, score,
    tags: [source === "hunter" ? "scraped" : "fresh"],
    n: [nx, ny, nz], updatedAt: nowSec(),
  };
  await (await resolve())
    .prepare("INSERT INTO leads (id, name, company, handle, email, channel, stage, value, score, tags, nx, ny, nz, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, lead.name, lead.company, lead.handle, lead.email, source, "pending_outreach", value, score, JSON.stringify(lead.tags), nx, ny, nz, lead.updatedAt)
    .run();
  return lead;
}

export async function computeMetrics(): Promise<Metrics> {
  // Derived from the same live Supabase leads the node map renders — no
  // separate D1 query, so the two can't drift out of sync with each other.
  const leads = await allLeads();
  const stageMap: Record<string, number> = {};
  let pipelineCents = 0;
  let activeNodes = 0;
  let repliedOrBetter = 0;
  for (const l of leads) {
    stageMap[l.stage] = (stageMap[l.stage] ?? 0) + 1;
    if (l.stage !== "lost" && l.stage !== "no_show") {
      pipelineCents += l.value;
      activeNodes += 1;
    }
    if (l.stage === "replied" || l.stage === "qualified" || l.stage === "won") repliedOrBetter += 1;
  }

  const [hunter, outreach, auto, throttle] = await Promise.all([
    getSetting("hunter_running", "1"),
    getSetting("outreach_running", "1"),
    getSetting("auto_reply", "1"),
    getSetting("throttle_pct", "72"),
  ]);

  const totalLeads = leads.length || 1;

  return {
    activeNodes,
    pipelineCents,
    pendingReplies: stageMap["replied"] ?? 0,
    pendingOutreach: stageMap["pending_outreach"] ?? 0,
    pendingSends: stageMap["outreach_sent"] ?? 0,
    won: stageMap["won"] ?? 0,
    noShows: stageMap["no_show"] ?? 0,
    replyRate: totalLeads > 0 ? repliedOrBetter / totalLeads : 0,
    loadPct: Math.min(97, 42 + Math.round(activeNodes * 0.02)),
    throttlePct: Number(throttle) || 72,
    hunterRunning: hunter === "1",
    outreachRunning: outreach === "1",
    autoReply: auto === "1",
  };
}

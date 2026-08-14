// Self-initializing migrations. Runs lazily on the first request that hits the
// DB on the deployed worker (the platform CI doesn't apply migrations). Applies
// app/migrations/0001-0003 in order. Idempotent — every statement is
// CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE, so replays are no-ops.
import { bindings } from "./bindings.server";

let ran = false;

export async function ensureMigrated(): Promise<void> {
  if (ran) return;
  ran = true;
  const db = bindings().DB;
  if (!db) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL, handle TEXT, email TEXT,
        channel TEXT NOT NULL DEFAULT 'inbound', stage TEXT NOT NULL DEFAULT 'pending_outreach',
        value INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 50, tags TEXT NOT NULL DEFAULT '[]',
        nx REAL NOT NULL DEFAULT 0, ny REAL NOT NULL DEFAULT 0, nz REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', body TEXT NOT NULL, badge TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'check',
        text TEXT NOT NULL, datum TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at DESC)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        title TEXT NOT NULL, storage_key TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('hunter_running','1'),('outreach_running','1'),('daily_send_cap','120'),('auto_reply','1'),('throttle_pct','72')`),
      // Meetings
      db.prepare(`CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        start_ts INTEGER NOT NULL, duration_min INTEGER NOT NULL DEFAULT 30,
        status TEXT NOT NULL DEFAULT 'confirmed', notes TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_ts)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(lead_id, start_ts)`),
    ]);
    await seedIfEmpty();
  } catch (e) {
    console.error("[migrate] failed", e);
    ran = false; // retry next request
  }
}

async function seedIfEmpty() {
  // Intentionally a no-op. The cortex node map / metrics read Supabase only
  // (allLeads / computeMetrics). Seeding 26 fake D1 leads + demo events here
  // previously risked operators confusing local fixtures with live pipeline
  // data if any path still touched D1. Meetings schema is created above;
  // real leads/activity/messages come from Supabase.
  void bindings().DB;
}

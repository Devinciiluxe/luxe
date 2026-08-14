-- JARVIS CORTEX — schema + seed. Additive, idempotent.
-- Stages: pending_outreach -> outreach_sent -> replied -> qualified -> won | lost | no_show

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  handle TEXT,
  email TEXT,
  channel TEXT NOT NULL DEFAULT 'inbound',
  stage TEXT NOT NULL DEFAULT 'pending_outreach',
  value INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 50,
  tags TEXT NOT NULL DEFAULT '[]',
  nx REAL NOT NULL DEFAULT 0,
  ny REAL NOT NULL DEFAULT 0,
  nz REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                      -- user | jarvis | lead | system
  kind TEXT NOT NULL DEFAULT 'chat',       -- chat | automation | note
  body TEXT NOT NULL,
  badge TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'check',
  text TEXT NOT NULL,
  datum TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

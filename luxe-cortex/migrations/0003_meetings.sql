-- Booked meetings. One lead can have many bookings; canceled ones are kept for audit.
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  start_ts INTEGER NOT NULL,               -- unix seconds
  duration_min INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | canceled | done | no_show
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_ts);
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(lead_id, start_ts);

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
  const db = bindings().DB!;
  const count = await db.prepare("SELECT COUNT(*) AS c FROM leads").first<{ c: number }>();
  if ((count?.c ?? 0) > 0) return;

  // Seed the initial 26-lead graph — IDs match the 0002_seed.sql file.
  const leadsStmt = `INSERT OR IGNORE INTO leads (id,name,company,handle,email,channel,stage,value,score,tags,nx,ny,nz) VALUES
 ('ld-atlas','Amara Osei','Atlas Freight','@amarasei','amara@atlasfreight.io','inbound','qualified',420000,88,'["logistics","hot"]',-0.52,0.42,0.30),
 ('ld-nimbus','Devin Park','Nimbus SaaS','@devpark','devin@nimbus.so','hunter','replied',168000,74,'["saas"]',-0.60,0.22,-0.18),
 ('ld-kestrel','Riya Nair','Kestrel Dental','@riyan','riya@kestreldental.com','outbound','replied',110400,69,'["local","dental"]',-0.55,-0.05,0.42),
 ('ld-halcyon','Marcus Webb','Halcyon Fitness','@mwebb','marcus@halcyon.fit','inbound','replied',264000,81,'["fitness","multi-site"]',-0.30,0.58,-0.30),
 ('ld-orion','Sofia Reyes','Orion Realty','@sofiare','sofia@orionrealty.co','hunter','outreach_sent',92000,52,'["realty"]',-0.15,0.30,0.55),
 ('ld-vanta','Theo Lindqvist','Vanta Studio','@theol','theo@vanta.studio','inbound','won',560000,96,'["design","closed"]',-0.05,0.02,0.62),
 ('ld-quill','Jess Marin','Quill Media','@jessmarin','jess@quillmedia.tv','outbound','pending_outreach',76000,47,'["media"]',-0.38,-0.35,0.30),
 ('ld-mesa','Pablo Duarte','Mesa Tacos','@pablod','pablo@mesatacos.com','hunter','replied',84000,58,'["food","franchise"]',-0.62,-0.28,-0.12),
 ('ld-lyra','Hana Kim','Lyra Optics','@hanakim','hana@lyraoptics.com','inbound','qualified',300000,85,'["health","hot"]',-0.20,-0.52,0.18),
 ('ld-forge','Owen Blake','Forge Auto','@owenb','owen@forgeauto.co','outbound','pending_outreach',64000,41,'["auto"]',-0.44,-0.10,-0.44),
 ('ld-indigo','Priya Shah','Indigo Travel','@priyash','priya@indigotravel.com','inbound','replied',148000,71,'["travel"]',-0.10,-0.30,-0.30),
 ('ld-ridge','Cole Fischer','Ridge Roofing','@colef','cole@ridgeroofing.com','hunter','outreach_sent',136000,55,'["home-services"]',-0.34,0.12,0.02),
 ('ld-sable','Nadia Ahmad','Sable Beauty','@nadiaa','nadia@sablebeauty.com','inbound','won',176000,79,'["beauty","closed"]',-0.22,-0.55,-0.02),
 ('ld-talon','Greg Moss','Talon Security','@gregm','greg@talonsec.io','outbound','no_show',0,22,'["security","ghosted"]',0.18,0.56,0.28),
 ('ld-cinder','Lena Fischer','Cinder Coffee','@lenaf','lena@cindercoffee.co','inbound','replied',48000,63,'["hospitality"]',0.28,0.38,-0.32),
 ('ld-drift','Yusuf Ali','Drift Boards','@yusufa','yusuf@driftboards.com','hunter','outreach_sent',58000,49,'["retail"]',0.52,0.30,0.36),
 ('ld-ember','Clara Voss','Ember Yoga','@clarav','clara@emberyoga.com','inbound','qualified',96000,77,'["wellness","hot"]',0.58,0.10,-0.18),
 ('ld-pinnacle','Dan Rourke','Pinnacle Law','@danr','dan@pinnaclelaw.com','outbound','pending_outreach',312000,66,'["legal","high-value"]',0.60,-0.14,0.40),
 ('ld-haven','Mia Torres','Haven Vet','@miat','mia@havenvet.com','inbound','replied',72000,61,'["petcare"]',0.40,-0.02,0.60),
 ('ld-flux','Arjun Mehta','Flux Games','@arjunm','arjun@fluxgames.gg','hunter','replied',204000,73,'["gaming"]',0.15,-0.42,0.42),
 ('ld-grove','Ella Novak','Grove Market','@ellan','ella@grovemarket.farm','outbound','outreach_sent',44000,38,'["cpg"]',0.36,-0.50,-0.08),
 ('ld-harbor','Sam Iyer','Harbor Hotels','@sami','sam@harborhotels.com','inbound','replied',388000,84,'["hospitality","high-value"]',0.60,-0.38,-0.30),
 ('ld-iron','Kate Molloy','Iron Works Gym','@katem','kate@ironworks.gym','hunter','pending_outreach',68000,45,'["fitness"]',0.25,0.24,0.02),
 ('ld-juniper','Leo Brandt','Juniper Photos','@leob','leo@juniper.photos','inbound','won',52000,69,'["creative","closed"]',0.10,0.62,-0.10),
 ('ld-koda','Zainab Bello','Koda Events','@zainabb','zainab@kodaevents.com','outbound','no_show',0,18,'["events","ghosted"]',0.45,0.48,-0.42),
 ('ld-lumen','Noel Franks','Lumen Solar','@noelf','noel@lumensolar.energy','inbound','replied',516000,90,'["solar","high-value","hot"]',0.05,-0.20,0.20)`;
  await db.prepare(leadsStmt).run();

  const msgRows = [
    ['m-at-1','ld-atlas','lead','chat','We need bookings for three regional depots. Current agency keeps missing follow-ups.',null,-10200],
    ['m-at-2','ld-atlas','jarvis','automation','Pulled your intake answers. Scored 88. Prepping outreach plan for the three depots and a pricing matrix.','ACTIVE',-9600],
    ['m-nb-1','ld-nimbus','jarvis','automation','Hunter scrape: matched 41 contacts at Nimbus SaaS from the public team page plus LinkedIn index.','SCRAPED',-14200],
    ['m-ks-3','ld-kestrel','lead','chat','Recall no-shows are killing us. If your system books and reminds, I want in.',null,-10800],
    ['m-hc-3','ld-halcyon','lead','chat','Book me a call for Friday. After 2pm.',null,-8100],
    ['m-lm-1','ld-lumen','lead','chat','Inbound from your referral link. We did $4.2M last year, no SDR team.',null,-30600],
  ];
  const stmt = db.prepare("INSERT OR IGNORE INTO messages (id,lead_id,role,kind,body,badge,created_at) VALUES (?,?,?,?,?,?,unixepoch()+?)");
  await db.batch(msgRows.map((r) => stmt.bind(...(r as [string,string,string,string,string,string|null,number]))));

  const evStmt = db.prepare("INSERT INTO events (kind,icon,text,datum,created_at) VALUES (?,?,?,?,unixepoch()+?)");
  await db.batch([
    evStmt.bind('scrape','check','Hunter sweep: 214 public profiles indexed, 41 fit','41',-3600),
    evStmt.bind('alert','warn','Talon Security went silent after 3 sends','3',-3300),
    evStmt.bind('reply','check','Atlas Freight: reply landed, scored 88','88',-3120),
    evStmt.bind('stage','check','Harbor Hotels moved Replied to Qualified','84',-2940),
    evStmt.bind('metric','check','Reply rate up to 38.1 percent this week','38.1%',-2520),
    evStmt.bind('alert','warn','Throttling outbound: daily cap 80 percent used','80%',-2340),
    evStmt.bind('alert','warn','Koda Events no-show risk: two misses','2',-1200),
    evStmt.bind('reply','check','Lumen Solar: budget confirmed on thread','90',-2100),
    evStmt.bind('stage','check','Vanta Studio closed, onboarding kicked','96',-1680),
    evStmt.bind('system','check','Nexus sync: all edge functions green','OK',-480),
  ]);
}

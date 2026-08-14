/**
 * LUXE platform worker — Lightpanda edition.
 *
 * Polls the Supabase `browser_jobs` queue and executes Airbnb browser jobs
 * through Lightpanda (CDP). Replaces the old Playwright ops scripts; all DOM
 * pathways ported from LUXE-MSTR (ops/airbnb_*.py).
 *
 * Job kinds (browser_jobs.kind):
 *   session_refresh   — log in (semi-manual first run), capture cookies/JWT,
 *                       upsert into platform_sessions
 *   inbox_sync        — read /hosting/messages, upsert threads + messages
 *   send_message      — { thread_url } or { listing_id } cold contact:
 *                       listing -> date picker -> message host -> send
 *   scrape_listing    — listing facts + photo URLs -> photos table / job result
 *   scrape_search     — search a market, upsert listings as leads
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (legacy service_role JWT),
 *      LIGHTPANDA_WS (default ws://127.0.0.1:9222)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// ---------------------------------------------------------------- config

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";
const LP_WS = process.env.LIGHTPANDA_WS ?? "ws://127.0.0.1:9222";
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS ?? 90_000);
const VIEWPORT = { width: 1440, height: 900 };
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  process.exit(1);
}

const db: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------- Airbnb pathways
// Ported from LUXE-MSTR ops/airbnb_*.py (Playwright -> CDP).

const SEL = {
  cookieBanner: '[data-testid="main-cookies-banner-container"]',
  cookieButtons: ["Only necessary", "Accept all", "OK"],
  composer: '[role="textbox"]', // contenteditable plaintext-only: type, never set value
  sendButton: 'button[aria-label="Send"]',
  inboxRows: 'a[data-testid^="inbox_list_"]', // testid = inbox_list_{threadId}
  msgBubble: '[data-testid="MessageOuterRegistryWrapperSpacingProps"]',
  roomLinks: 'a[href*="/rooms/"]',
  hostLink: 'a[href*="/users/show/"]',
};

const RE = {
  threadId: /inbox_list_(\d+)/,
  roomId: /\/rooms\/(\d+)/,
  place: /(?:Entire\s+\w+|Private room|Room)\s+in\s+([^\n·]{2,60})/i,
  guests: /([\d.]+)\s*guests?/i,
  bedrooms: /(\d+)\s*bedrooms?/i,
  baths: /([\d.]+)\s*bath/i,
  priceNight: /\$\s?([\d,]+)\s*(?:CAD|USD)?\s*(?:per night|night|\/\s*night)/i,
  oneNightTotal: /\$\s?([\d,]+)\s*USD\s*total/i,
  email: /[\w.+-]+@[\w-]+\.[\w.]+/g,
  phone: /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
};

const INBOX_PATH = "/hosting/messages";

// ------------------------------------------------------------ CDP client

type CdpResult = { id: number; result?: any; error?: { message: string } };

class Cdp {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sessionId = "";

  async connect(): Promise<void> {
    // Lightpanda exposes a single browser-level WebSocket at ws://host:9222/.
    // Targets are created via Target.createTarget over that socket.
    const res = await fetch(`${LP_WS.replace(/^ws/, "http").replace(/\/$/, "")}/json/version`);
    if (!res.ok) throw new Error(`Lightpanda /json/version failed: ${res.status}`);
    const info = (await res.json()) as { webSocketDebuggerUrl: string };

    this.ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(e));
    });
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    });

    // Create a page target and attach to it.
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;

    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    await this.send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT, deviceScaleFactor: 1, mobile: false,
    });
    await this.send("Network.setUserAgentOverride", { userAgent: UA });
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame: Record<string, any> = { id, method, params };
      if (this.sessionId) frame.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(frame));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60_000);
    });
  }

  async goto(url: string, settleMs = 4000): Promise<void> {
    await this.send("Page.navigate", { url });
    await sleep(settleMs);
  }

  /** Evaluate an expression, return by value. */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
    return r.result?.value as T;
  }

  /** Click the first element matching `selector` via DOM point dispatch. */
  async click(selector: string): Promise<boolean> {
    const point = await this.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      el.scrollIntoView({ block: "center" });
      const r2 = el.getBoundingClientRect();
      return { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };
    })()`);
    if (!point) return false;
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type, x: point.x, y: point.y, button: "left", clickCount: 1,
      });
    }
    return true;
  }

  /** Type text as real keystrokes (Airbnb composer is contenteditable). */
  async type(text: string): Promise<void> {
    for (const char of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
      await sleep(12 + Math.random() * 30); // human-ish cadence
    }
  }

  async exists(selector: string): Promise<boolean> {
    return this.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
  }

  async bodyText(): Promise<string> {
    return this.eval<string>(`(document.body?.innerText || "").replace(/\\s+/g, " ")`);
  }

  async currentUrl(): Promise<string> {
    return this.eval<string>("location.href");
  }

  async cookies(): Promise<any[]> {
    const r = await this.send("Network.getAllCookies");
    return r.cookies ?? [];
  }

  async close(): Promise<void> {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------- shared steps

async function dismissCookieBanner(cdp: Cdp): Promise<void> {
  if (!(await cdp.exists(SEL.cookieBanner))) return;
  for (const label of SEL.cookieButtons) {
    const clicked = await cdp.eval<boolean>(`(() => {
      const btn = [...document.querySelectorAll("button")]
        .find(b => b.innerText.trim() === ${JSON.stringify(label)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (clicked) { await sleep(1200); return; }
  }
}

async function isLoggedIn(cdp: Cdp): Promise<boolean> {
  await cdp.goto("https://www.airbnb.com/account-settings", 3000);
  return !(await cdp.currentUrl()).includes("/login");
}

// -------------------------------------------------------- session store

// A session row is only usable if a real login actually established it.
// Rows 1 and 2 in production are status='active' with refreshed_at at the Unix
// epoch (1970-01-01) — they were never written by saveSession(), which always
// stamps refreshed_at=now(). Because the old query filtered on status alone and
// sorted by refreshed_at, those two epoch rows permanently shadowed every real
// login attempt, and the worker kept loading cookies that had never worked.
// Anything older than this cutoff is treated as absent rather than active.
const SESSION_EPOCH_CUTOFF = "2000-01-01T00:00:00.000Z";

async function getSession(): Promise<{ cookies: any[]; jwt: string } | null> {
  const { data } = await db
    .from("platform_sessions")
    .select("cookies_json, jwt, refreshed_at")
    .eq("platform", "airbnb")
    .eq("status", "active")
    .gt("refreshed_at", SESSION_EPOCH_CUTOFF)
    .order("refreshed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.cookies_json) return null;
  return { cookies: data.cookies_json as any[], jwt: (data.jwt as string) ?? "" };
}

async function saveSession(cdp: Cdp, status: string, error = ""): Promise<void> {
  const cookies = await cdp.cookies();
  const airbnb = cookies.filter((c: any) => String(c.domain).includes("airbnb"));
  const jwtCookie = airbnb.find((c: any) => c.name === "_jwt");
  await db.from("platform_sessions").insert({
    platform: "airbnb",
    status,
    cookies_json: airbnb,
    jwt: jwtCookie?.value ?? "",
    user_agent: UA,
    lightpanda_url: LP_WS,
    refreshed_at: new Date().toISOString(),
    // last_used_at previously had no writer at all: every row in production sat
    // at the Unix epoch, yet pipeline_audit.py selected it AND sorted by it, so
    // the audit reported a never-touched column as a real date. Write it here so
    // the column means what its name says.
    last_used_at: new Date().toISOString(),
    expires_at: jwtCookie?.expires
      ? new Date(jwtCookie.expires * 1000).toISOString()
      : "",
    last_error: error,
  });
}

async function restoreSession(cdp: Cdp): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  await cdp.goto("https://www.airbnb.com/", 2500); // right origin before setting cookies
  for (const c of session.cookies) {
    try {
      await cdp.send("Network.setCookie", {
        name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
        secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
        ...(c.expires ? { expires: c.expires } : {}),
      });
    } catch { /* individual cookie rejected — keep going */ }
  }
  return isLoggedIn(cdp);
}

// ------------------------------------------------------------- job kinds

/** session_refresh: full login flow through Lightpanda.
 *  Credentials come from the settings table (key='airbnb_credentials',
 *  value jsonb {email, password}) — never from job payloads or code.
 *  Flow: /login -> #phone-or-email + Continue -> step 2 offers either a
 *  password field, a "use password instead" link, or a verification-code
 *  input. If Airbnb demands a code, the worker parks state in settings
 *  (key='airbnb_login_challenge') and polls until the dashboard/user writes
 *  the code back, then completes login and captures cookies. */
async function jobSessionRefresh(cdp: Cdp, payload: any): Promise<any> {
  if (await restoreSession(cdp)) {
    await saveSession(cdp, "active");
    return { mode: "refreshed_from_cookies" };
  }

  const creds = await getSetting("airbnb_credentials");
  if (!creds?.email) throw new Error("no airbnb_credentials in settings table");

  await cdp.goto("https://www.airbnb.com/login", 6000);
  await dismissCookieBanner(cdp);

  // Step 1: email -> Continue
  await cdp.eval(`(() => {
    const el = document.querySelector("#phone-or-email");
    el.focus(); el.value = ${JSON.stringify(creds.email)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickButtonWithText(cdp, ["Continue"]);
  await sleep(4000);

  // Step 2: what did Airbnb present?
  const hasPassword = await cdp.eval<boolean>(`!!document.querySelector('input[type="password"], input[name="user[password]"], #password')`);
  if (!hasPassword) {
    // Prefer password over emailed code when offered the choice.
    await clickLinkWithText(cdp, ["use password instead", "password instead", "log in with password", "use password"]);
    await sleep(3000);
  }
  const hasPasswordNow = await cdp.eval<boolean>(`!!document.querySelector('input[type="password"], input[name="user[password]"], #password')`);
  if (hasPasswordNow && creds.password) {
    await cdp.eval(`(() => {
      const el = document.querySelector('input[type="password"], input[name="user[password]"], #password');
      el.focus(); el.value = ${JSON.stringify(creds.password)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await clickButtonWithText(cdp, ["Log in", "Continue", "Sign in"]);
    await sleep(6000);
  }

  // Verification-code wall? Park and wait for the human to supply it.
  const needsCode = await cdp.eval<boolean>(`(() => {
    const inputs = [...document.querySelectorAll("input")];
    const t = (document.body?.innerText || "").toLowerCase();
    return inputs.some(i => /code|otp|verification/i.test(i.name + i.id + (i.getAttribute("data-testid") || "")))
      || t.includes("enter the code") || t.includes("verification code") || t.includes("we sent") ;
  })()`);

  if (needsCode || (await cdp.currentUrl()).includes("/login")) {
    if (!needsCode && (await isLoggedIn(cdp))) {
      await saveSession(cdp, "active");
      return { mode: "password_login_captured" };
    }
    if (needsCode) {
      await setSetting("airbnb_login_challenge", { waiting: true, since: new Date().toISOString() });
      const code = await waitForCode(Number(payload.code_wait_ms ?? 900_000));
      await setSetting("airbnb_login_challenge", { waiting: false });
      await cdp.eval(`(() => {
        const el = [...document.querySelectorAll("input")]
          .find(i => /code|otp|verification/i.test(i.name + i.id + (i.getAttribute("data-testid") || "")) || i.type === "tel" || i.type === "number");
        if (el) { el.focus(); el.value = ${"`${code}`"}; el.dispatchEvent(new Event("input", { bubbles: true })); }
      })()`);
      if (await cdp.exists('[role="textbox"]')) { /* code boxes sometimes render as textbox */ }
      await clickButtonWithText(cdp, ["Continue", "Verify", "Log in", "Submit"]);
      await sleep(6000);
    } else {
      // Something else is blocking (captcha, rate limit). Wait for a human-driven
      // completion window as the last resort.
      const deadline = Date.now() + Number(payload.login_wait_ms ?? 600_000);
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(5000);
        if (await isLoggedIn(cdp)) { ok = true; break; }
      }
      if (!ok) {
        await saveSession(cdp, "expired", "login blocked (captcha/rate-limit/manual wait timeout)");
        throw new Error("login blocked — needs human");
      }
    }
  }

  if (!(await isLoggedIn(cdp))) {
    await saveSession(cdp, "expired", "post-login check failed");
    throw new Error("login did not stick");
  }
  await saveSession(cdp, "active");
  return { mode: "login_captured" };
}

// ---- login helpers ---------------------------------------------------------------------

async function getSetting(key: string): Promise<any> {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  if (data?.value == null) return null;
  try { return JSON.parse(data.value as string); } catch { return data.value; }
}
async function setSetting(key: string, value: any): Promise<void> {
  await db.from("settings").upsert(
    { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
    { onConflict: "key" });
}
async function waitForCode(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getSetting("airbnb_login_code");
    if (v?.code) {
      await setSetting("airbnb_login_code", {}); // consume once
      return String(v.code).trim();
    }
    await sleep(4000);
  }
  throw new Error("verification code wait timed out");
}
async function clickButtonWithText(cdp: Cdp, labels: string[]): Promise<boolean> {
  return cdp.eval<boolean>(`(() => {
    const labels = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
    const el = [...document.querySelectorAll("button")]
      .find(b => labels.some(l => (b.innerText || "").trim().toLowerCase().includes(l)));
    if (!el) return false;
    el.click();
    return true;
  })()`);
}
async function clickLinkWithText(cdp: Cdp, labels: string[]): Promise<boolean> {
  return cdp.eval<boolean>(`(() => {
    const labels = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
    const el = [...document.querySelectorAll("a, button, span[role='button']")]
      .find(b => labels.some(l => (b.innerText || "").trim().toLowerCase().includes(l)));
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

/** inbox_sync: list threads, read each, upsert into messages. */
async function jobInboxSync(cdp: Cdp, payload: any): Promise<any> {
  if (!(await restoreSession(cdp))) throw new Error("no valid session — queue session_refresh");
  await cdp.goto(`https://www.airbnb.com${INBOX_PATH}`, 6000);
  await dismissCookieBanner(cdp);

  const threads = await cdp.eval<{ id: string; href: string }[]>(`(() => {
    const out = [];
    for (const a of document.querySelectorAll(${JSON.stringify(SEL.inboxRows)})) {
      const m = (a.getAttribute("data-testid") || "").match(/inbox_list_(\\d+)/);
      if (m) out.push({ id: m[1], href: a.href });
    }
    return out;
  })()`);
  if (!threads.length) throw new Error("no threads found — session likely expired");

  const limit = Number(payload.limit ?? 25);
  let synced = 0;
  const failures: string[] = [];
  for (const t of threads.slice(0, limit)) {
    try {
      await cdp.goto(`https://www.airbnb.com${INBOX_PATH}/${t.id}`, 4000);
      const rec = await cdp.eval<any>(`(() => {
        const bubbles = [...document.querySelectorAll(${JSON.stringify(SEL.msgBubble)})];
        return {
          title: (document.querySelector("h1")?.innerText || "").trim(),
          listing: (document.body.innerHTML.match(/\\/rooms\\/(\\d+)/) || [])[1] || "",
          messages: bubbles.map(b => b.innerText.trim()).filter(Boolean),
        };
      })()`);
      // messages is an append-only outreach log keyed by lead; thread identity
      // and scrape metadata ride in meta (json string), latest body in body.
      // supabase-js resolves rather than throws on a rejected write, so an
      // unchecked insert let `synced` count rows that never landed — a done
      // job could report "synced: 25" against zero stored threads.
      const { error: insErr } = await db.from("messages").insert({
        lead_id: payload.lead_id ?? t.id,
        order_id: "",
        direction: "inbound",
        channel: "airbnb",
        category: "inbox_sync",
        sent_as: "worker",
        body: rec.messages.join("\n---\n").slice(0, 8000),
        intent: "",
        template_id: "",
        meta: JSON.stringify({
          thread_id: t.id, thread_url: t.href,
          listing_id: rec.listing, with_name: rec.title,
          message_count: rec.messages.length,
          scraped_at: new Date().toISOString(),
        }),
      });
      if (insErr) throw new Error(`messages insert rejected: ${insErr.message}`);
      synced++;
      await sleep(1500);
    } catch (e) {
      console.error(`thread ${t.id} failed:`, (e as Error).message);
      failures.push(`${t.id}: ${(e as Error).message}`);
    }
  }
  // Threads were on screen but none stored => the sync did not happen. Fail the
  // job rather than returning a green "done" with synced: 0.
  if (synced === 0) throw new Error(`0 of ${threads.length} threads stored — ${failures[0] ?? "no rows written"}`);
  return { threads_found: threads.length, synced, failed: failures.length, failures: failures.slice(0, 10) };
}

/** send_message: existing thread ({thread_url}) or cold contact via listing
 *  ({listing_id}) — date picker wall, then the message-host entry. */
async function jobSendMessage(cdp: Cdp, payload: any): Promise<any> {
  const body: string = payload.body ?? "";
  if (!body) throw new Error("job missing body");
  if (!(await restoreSession(cdp))) throw new Error("no valid session — queue session_refresh");

  if (payload.thread_url) {
    await cdp.goto(payload.thread_url, 4000);
  } else if (payload.listing_id) {
    // Cold contact: listing -> choose dates (the date-picker wall) -> message host.
    const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
    const checkout = new Date(Date.now() + 46 * 864e5).toISOString().slice(0, 10);
    await cdp.goto(
      `https://www.airbnb.com/rooms/${payload.listing_id}?check_in=${checkin}&check_out=${checkout}&adults=2`, 5000);
    await dismissCookieBanner(cdp);
    // "Message host" sits below the reserve panel; aria-label varies slightly.
    const opened = await cdp.eval<boolean>(`(() => {
      const els = [...document.querySelectorAll("a, button")];
      const el = els.find(e => /message host|contact host/i.test(e.innerText || ""));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!opened) throw new Error("message-host entry not found (dates rejected? try other dates)");
    await sleep(2500);
  } else {
    throw new Error("job needs thread_url or listing_id");
  }

  await dismissCookieBanner(cdp);
  if (!(await cdp.exists(SEL.composer))) throw new Error("composer not found (session expired?)");
  await cdp.click(SEL.composer);
  await sleep(600);
  await cdp.type(body);
  await sleep(1200);

  if (payload.dry_run) {
    await cdp.eval(`(() => { const b = document.querySelector(${JSON.stringify(SEL.composer)}); if (b) b.innerText = ""; })()`);
    return { dry_run: true, composed: true };
  }
  if (!(await cdp.click(SEL.sendButton))) throw new Error("send button not found/disabled");
  await sleep(3500);

  // Verify the send actually landed — clicking Send is not proof Airbnb
  // accepted it. Confirm (a) the composer emptied out (Airbnb clears it on
  // successful post, keeps your text if the send silently failed/blocked)
  // and (b) the most recent message bubble in the thread contains a snippet
  // of what we typed. Without both, this is NOT a confirmed send.
  const snippet = body.trim().slice(0, 24).toLowerCase();
  const verification = await cdp.eval<{ composerEmpty: boolean; lastBubbleMatches: boolean; lastBubbleText: string }>(`(() => {
    const box = document.querySelector(${JSON.stringify(SEL.composer)});
    const composerEmpty = !box || !box.innerText || box.innerText.trim().length === 0;
    const bubbles = [...document.querySelectorAll(${JSON.stringify(SEL.msgBubble)})];
    const last = bubbles.length ? bubbles[bubbles.length - 1] : null;
    const lastBubbleText = last ? (last.innerText || "") : "";
    const lastBubbleMatches = lastBubbleText.toLowerCase().includes(${JSON.stringify(snippet)});
    return { composerEmpty, lastBubbleMatches, lastBubbleText: lastBubbleText.slice(0, 80) };
  })()`);

  if (!verification.composerEmpty || !verification.lastBubbleMatches) {
    throw new Error(
      `send not confirmed — composerEmpty=${verification.composerEmpty} ` +
      `lastBubbleMatches=${verification.lastBubbleMatches} lastBubble="${verification.lastBubbleText}"`
    );
  }

  return { sent: true, verified: true, thread: await cdp.currentUrl() };
}

/** scrape_listing: facts + photo URLs for one listing. */
async function jobScrapeListing(cdp: Cdp, payload: any): Promise<any> {
  const id = String(payload.listing_id ?? "");
  if (!id) throw new Error("job missing listing_id");
  const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  const checkout = new Date(Date.now() + 46 * 864e5).toISOString().slice(0, 10);
  await cdp.goto(`https://www.airbnb.com/rooms/${id}?check_in=${checkin}&check_out=${checkout}&adults=2&currency=USD`, 5000);
  await dismissCookieBanner(cdp);
  const text = await cdp.bodyText();
  const grab = (re: RegExp, cast: (s: string) => any = (s) => s) => {
    const m = text.match(re); return m ? cast(m[1].replace(/,/g, "")) : null;
  };
  const photos = await cdp.eval<string[]>(`(() => {
    const srcs = new Set();
    for (const img of document.querySelectorAll("img")) {
      const s = img.src || "";
      if (s.includes("muscache")) srcs.add(s.split("?")[0]);
    }
    return [...srcs];
  })()`);
  const hostUrl = await cdp.eval<string>(`document.querySelector(${JSON.stringify(SEL.hostLink)})?.href || ""`);
  const detail = {
    listing_id: id,
    title: await cdp.eval<string>(`(document.querySelector("h1")?.innerText || "").trim()`),
    place: grab(RE.place, String),
    bedrooms: grab(RE.bedrooms, Number) ?? 0,
    bathrooms: grab(RE.baths, Number) ?? 0,
    guests: grab(RE.guests, Number) ?? 0,
    nightly_rate: grab(RE.priceNight, Number) ?? grab(RE.oneNightTotal, Number) ?? 0,
    host_url: hostUrl,
    emails: [...new Set(text.match(RE.email) ?? [])].filter((e) => !e.toLowerCase().includes("airbnb")),
    phone: text.match(RE.phone)?.[0] ?? "",
    photo_count: photos.length,
    photos,
    scraped_at: new Date().toISOString(),
  };
  if (payload.lead_id) {
    // `bathrooms` is not a column on leads — including it made PostgREST reject
    // the whole PATCH, and the unchecked result meant scrape_listing still
    // finished "done" with none of the enrichment saved.
    const { error: updErr } = await db.from("leads").update({
      bedrooms: detail.bedrooms,
      nightly_rate: detail.nightly_rate, photo_count: detail.photo_count,
      updated_at: new Date().toISOString(),
    }).eq("id", payload.lead_id);
    if (updErr) throw new Error(`leads update rejected for ${payload.lead_id}: ${updErr.message}`);
  }
  return detail;
}

/** scrape_search: search a market, collect listing cards, upsert as leads.
 *  payload: { city, max_pages?, min_bedrooms? } */
async function jobScrapeSearch(cdp: Cdp, payload: any): Promise<any> {
  const city = String(payload.city ?? "");
  if (!city) throw new Error("job missing city");
  const maxPages = Number(payload.max_pages ?? 3);
  const minBed = String(payload.min_bedrooms ?? "3");
  const searchUrl = `https://www.airbnb.com/s/${encodeURIComponent(city)}/homes?min_bedrooms=${minBed}`;

  const found = new Map<string, string>();
  let url = searchUrl;
  for (let pageNum = 0; pageNum < maxPages && url; pageNum++) {
    await cdp.goto(url, 6000);
    await dismissCookieBanner(cdp);
    const cards = await cdp.eval<{ id: string; href: string }[]>(`(() => {
      const out = [];
      for (const a of document.querySelectorAll(${JSON.stringify(SEL.roomLinks)})) {
        const m = (a.getAttribute("href") || "").match(/\\/rooms\\/(\\d+)/);
        if (m) out.push({ id: m[1], href: "https://www.airbnb.com/rooms/" + m[1] });
      }
      return out;
    })()`);
    for (const c of cards) found.set(c.id, c.href);
    // Pagination: "Next" link, if present.
    url = await cdp.eval<string>(`(() => {
      const a = [...document.querySelectorAll("a")].find(x => /next/i.test(x.getAttribute("aria-label") || x.innerText || ""));
      return a ? a.href : "";
    })()`);
    await sleep(2500);
  }

  let inserted = 0;
  for (const [id, href] of found) {
    const { error } = await db.from("leads").upsert({
      source_platform: "airbnb",
      source_url: href,
      contact_route: "airbnb_platform",
      status: "new",
      track: "airbnb",
      dedupe_hash: `airbnb_${id}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "dedupe_hash", ignoreDuplicates: true });
    if (!error) inserted++;
  }
  return { city, listings_found: found.size, inserted };
}

const HANDLERS: Record<string, (cdp: Cdp, payload: any) => Promise<any>> = {
  session_refresh: jobSessionRefresh,
  inbox_sync: jobInboxSync,
  send_message: jobSendMessage,
  scrape_listing: jobScrapeListing,
  scrape_search: jobScrapeSearch,
};

// --------------------------------------------------------------- queue

async function claimJob(): Promise<any | null> {
  // Claim-by-update: mark oldest pending job claimed; retry loop handles races.
  for (let i = 0; i < 3; i++) {
    const { data: job } = await db
      .from("browser_jobs")
      .select("*")
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!job) return null;
    const { data: claimed, error } = await db
      .from("browser_jobs")
      .update({ status: "claimed", claimed_at: new Date().toISOString(), attempts: (job.attempts ?? 0) + 1 })
      .eq("id", job.id)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    if (!error && claimed) return claimed;
  }
  return null;
}

async function finishJob(id: string, ok: boolean, result: any, error = ""): Promise<void> {
  await db.from("browser_jobs").update({
    status: ok ? "done" : "failed",
    result: result ?? {},
    error,
    done_at: new Date().toISOString(),
  }).eq("id", id);
}

async function main(): Promise<void> {
  console.log(`[worker] polling ${SUPABASE_URL} every ${POLL_MS}ms, lightpanda at ${LP_WS}`);
  let lastSend = 0;
  for (;;) {
    const job = await claimJob().catch((e) => { console.error("claim:", e.message); return null; });
    if (!job) { await sleep(POLL_MS); continue; }

    const handler = HANDLERS[job.kind];
    if (!handler) { await finishJob(job.id, false, {}, `unknown kind: ${job.kind}`); continue; }

    // Send pacing: one outbound message per SEND_DELAY_MS, enforced worker-side.
    if (job.kind === "send_message" && !job.payload?.dry_run) {
      const wait = SEND_DELAY_MS - (Date.now() - lastSend);
      if (wait > 0) await sleep(wait);
    }

    const cdp = new Cdp();
    try {
      await cdp.connect();
      const result = await handler(cdp, job.payload ?? {});
      await finishJob(job.id, true, result);
      if (job.kind === "send_message") lastSend = Date.now();
      console.log(`[worker] ${job.kind} ${job.id} done`);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[worker] ${job.kind} ${job.id} failed:`, msg);
      const retryable = (job.attempts ?? 1) < (job.max_attempts ?? 3) && !/no valid session/.test(msg);
      if (retryable) {
        await db.from("browser_jobs").update({ status: "pending", error: msg }).eq("id", job.id);
      } else {
        await finishJob(job.id, false, {}, msg);
        if (/session|login|composer/.test(msg)) {
          // Auto-queue a session refresh so the loop self-heals.
          await db.from("browser_jobs").insert({
            id: `bj_session_${crypto.randomUUID().replaceAll("-", "")}`,
            kind: "session_refresh", status: "pending", priority: 100, payload: {},
          });
        }
      }
    } finally {
      await cdp.close();
    }
  }
}

main();

// Owner auth for the Cortex dashboard. Session = a signed, HttpOnly cookie with
// an HMAC over the expiry. One operator, one key. Change PIN by editing OWNER_PIN,
// or wire it to a website_secrets entry later.
const OWNER_PIN = "2155";
const COOKIE_NAME = "jarvis_cortex_session";
const TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export function getCookieName(): string {
  return COOKIE_NAME;
}

async function sign(payload: string): Promise<string> {
  const raw = new TextEncoder().encode(`jarvis-cortex::${OWNER_PIN}::${payload}`);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function verifyPin(pin: string): Promise<boolean> {
  return pin === OWNER_PIN;
}

export async function createSession(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const sig = await sign(`${exp}`);
  return `${exp}.${sig}`;
}

export async function readSession(request: Request): Promise<boolean> {
  const cookie = request.headers.get("cookie") ?? "";
  const part = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!part) return false;
  const value = part.slice(COOKIE_NAME.length + 1);
  const [expStr, sig] = value.split(".");
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return (await sign(expStr)) === sig;
}

export function sessionCookieHeader(value: string, maxAgeSec = TTL_SEC): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

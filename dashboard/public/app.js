// Mission Jarvis — DEMO client only. There is no server.mjs in this folder.
// npm start → refuse-demo-start.mjs. Numbers come from mission-data.js (static).
// Live pipeline UI: luxe-cortex /cortex (JARVIS_MINDMAP_URL), Supabase-backed.
const HUE = { live: "#34E0D0", attention: "#F7B54F", stuck: "#FF6B6B", ai: "#786EFF", value: "#C6A469", idle: "#93A0A6" };
const KIND_DOT = { stage_change: "#34E0D0", awaiting_human: "#F7B54F", negotiation: "#786EFF", lead_run: "#C6A469", call: "#786EFF", reply: "#34E0D0", outbox: "#34E0D0" };
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const $ = (s) => document.querySelector(s);
const D = window.MJ3;
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const app = {
  space: null, live: false, feed: D.feed.slice(), workers: D.workers.slice(),
  outboxOverrides: {}, insp: null, thread: null, aiReply: true,
  speaking: false, paused: false, audioOn: false, micOn: false,
  walkIdx: 0, evIdx: 0, ac: null, master: null, voice: undefined,
  // Voice-narration bookkeeping: dedupe key of every feed entry already seen
  // (seeded from the boot snapshot so we never read the backlog aloud) and a
  // small queue so overlapping events narrate one at a time.
  seenFeedKeys: new Set(D.feed.map((f) => `${f.kind}|${f.message}`)),
  voiceQueue: [],
};

function fmtTime(d = new Date()) { const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; }
function pushFeed(kind, message) { app.feed = [{ time: fmtTime(), kind, message }, ...app.feed].slice(0, 26); renderFeed(); }
// Merge a batch of feed rows (server /api/state action feed, or the live DB
// activity feed from /mission-data.json) into the displayed feed, deduped by
// message text. Returns just the newly-added rows, newest first, so callers
// can react to "what's actually new" (e.g. speak it) without re-processing
// everything that was already on screen.
function mergeFeedEntries(entries) {
  if (!entries?.length) return [];
  const seen = new Set(app.feed.map((f) => f.message));
  const added = [];
  for (const f of entries) { if (!seen.has(f.message)) { added.push(f); seen.add(f.message); } }
  if (added.length) { app.feed = [...added, ...app.feed].slice(0, 26); renderFeed(); }
  return added;
}

/* ---------- server polling (disabled on demo surface) ---------- */
async function pollState() {
  // No-op: root dashboard has no server. Never fetch /api/state or look "live".
  app.live = false;
  const el = $("#srcline");
  if (el) {
    el.textContent = "DEMO ONLY · STATIC mission-data.js · NOT SUPABASE";
    el.style.color = "rgba(255,107,107,.85)";
  }
}
async function callApi(path, body) {
  // Demo surface: never imply API writes reached Postgres/Supabase.
  return { ok: false, offline: true, demo: true };
}

/* ---------- live snapshot polling — intentionally disabled ----------
 * Historical notes referenced a removed server.mjs + live-data.mjs Postgres
 * path. That path is gone. Authoritative live UI is luxe-cortex /cortex. */
async function pollLiveData() {
  // Intentionally no-op: root dashboard has no live server. Never overwrite
  // demo KPIs with a fetch that could look "live". Authoritative UI is luxe-cortex.
  return;
}
function applyLiveUpdate(fresh) {
  D.kpis = fresh.kpis; D.workers = fresh.workers; D.outbox = fresh.outbox;
  D.dossiers = fresh.dossiers; D.conversations = fresh.conversations;
  app.workers = fresh.workers.slice();
  renderKpis(); renderAgents();

  // Node graph: only tear down and rebuild the Three.js scene when the set of
  // node ids actually changed (a new hot lead/order appeared, or one dropped
  // out of the hot window) — cheap re-renders every 5s otherwise.
  const oldIds = D.nodes.map((n) => n.id).sort().join(",");
  const newIds = fresh.nodes.map((n) => n.id).sort().join(",");
  D.nodes = fresh.nodes; D.links = fresh.links;
  if (app.space?.ready && oldIds !== newIds) {
    app.space.setData({ nodes: D.nodes, links: D.links });
  }

  // Inspector panel: refresh in place if the node it's showing still exists —
  // don't touch it if the note text is unchanged, so the typewriter doesn't
  // restart every poll for no reason.
  if (app.insp) {
    const d = D.dossiers[app.insp.nodeId];
    if (d) {
      const sig = d.note + "|" + d.state + "|" + JSON.stringify(d.rows) + "|" + JSON.stringify(d.chips);
      if (sig !== app.insp._sig) { app.insp = { nodeId: app.insp.nodeId, ...d, _sig: sig }; renderInsp(); }
    }
  }

  // Open thread: merge in any genuinely new messages without collapsing the
  // panel, losing scroll position, or wiping whatever the owner is typing —
  // renderThread() itself preserves those.
  if (app.thread) {
    const c = D.conversations.find((x) => x.leadId === app.thread.leadId);
    if (c) { mergeThreadMessages(c); renderThread(); }
  }

  // Ambient JARVIS narration: only the DB activity feed (fresh.feed) drives
  // speech — action feed entries (replies, reviews, hunts) already get an
  // immediate speak() call from their own handlers, so narrating them again
  // here would double them up.
  const added = mergeFeedEntries(fresh.feed);
  for (const f of added.slice().reverse()) {
    const key = `${f.kind}|${f.message}`;
    if (app.seenFeedKeys.has(key)) continue;
    app.seenFeedKeys.add(key);
    const line = speakable(f);
    if (line) app.voiceQueue.push({ text: line, tag: f.kind.toUpperCase() });
  }
  pumpVoiceQueue();
}

/* ---------- rendering ---------- */
function renderAgents() {
  $("#agents").innerHTML = app.workers.map((w) => `
    <div style="display:flex;gap:8px;align-items:flex-start">
      <i style="flex:none;margin-top:2px;width:10px;height:10px;border-radius:99px;${w.busy ? "border:1.5px solid rgba(52,224,208,.2);border-top-color:var(--cyan);animation:var(--spin)" : "border:1.5px solid rgba(255,255,255,.12)"}"></i>
      <div style="min-width:0"><div style="font:500 10.5px/1.2 var(--font-mono);letter-spacing:.06em;color:rgba(232,234,237,.8)">${w.name}</div>
      <div style="font:400 9px/1.45 var(--font-mono);color:var(--text-hud-mute);margin-top:2px">${w.status}</div></div>
    </div>`).join("");
}
function renderOutbox() {
  const ov = app.outboxOverrides;
  const items = D.outbox.queue.map((q) => ({ ...q, override: ov[q.id]?.status }));
  const queuedCount = items.filter((i) => i.override !== "sent").length;
  $("#obLine").innerHTML = `<span style="font:500 16px/1 var(--font-mono);color:var(--cyan-lift)">${queuedCount}</span><span style="font:400 9px/1 var(--font-mono);color:var(--text-hud-mute)">queued · ${D.outbox.sentToday + Object.values(ov).filter(o => o.status === "sent").length} of ${D.outbox.cap} sent · ${D.outbox.failed} failed</span>`;
  $("#obBar").style.width = Math.min(100, Math.round((queuedCount / D.outbox.cap) * 100)) + "%";
  $("#obQ").innerHTML = items.map((q) => {
    const held = q.override === "held" || (!q.override && /held/.test(q.eta));
    const sent = q.override === "sent";
    const color = sent ? "#93A0A6" : held ? "#F7B54F" : "#34E0D0";
    const etaText = sent ? "sent ✓" : q.eta;
    return `<div class="qrow"><span style="font:500 9px/1.2 var(--font-mono);letter-spacing:.06em;color:${color}">${q.id}</span>
      <span style="font:400 9px/1.3 var(--font-mono);color:var(--text-hud-dim);flex:1;min-width:0">${q.line}</span>
      <span style="font:400 8.5px/1.2 var(--font-mono);color:${held ? "#F7B54F" : "rgba(232,234,237,.38)"};white-space:nowrap">${etaText}</span>
      ${sent ? "" : `<button class="qbtn" data-act="send" data-id="${q.id}">SEND</button><button class="qbtn h" data-act="hold" data-id="${q.id}">HOLD</button>`}
    </div>`;
  }).join("");
  $("#obQ").querySelectorAll("button[data-act]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.id, act = b.dataset.act;
    blip(act === "send" ? 1200 : 620, 0.025, 0.07);
    const res = await callApi(`/api/outbox/${encodeURIComponent(id)}/${act}`);
    if (res.ok) { app.outboxOverrides[id] = { status: res.status }; pushFeed("outbox", `Outbox → ${id} ${act === "send" ? "sent" : "held"}`); }
    else pushFeed("outbox", `Outbox → ${id} ${act} (offline — not persisted)`);
    renderOutbox();
  });
}
function renderFeed() {
  $("#feed").innerHTML = app.feed.map((a) => `
    <div style="display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.035)">
      <span style="flex:none;font:400 9px/1.5 var(--font-mono);font-variant-numeric:tabular-nums;color:var(--text-hud-mute)">${a.time}</span>
      <i style="flex:none;width:4px;height:4px;border-radius:99px;background:${KIND_DOT[a.kind] || "rgba(147,160,166,.6)"};box-shadow:0 0 7px ${KIND_DOT[a.kind] || "rgba(147,160,166,.6)"};transform:translateY(-2px)"></i>
      <span style="font:400 9.5px/1.5 var(--font-mono);color:var(--text-hud-dim);min-width:0">${a.message}</span>
    </div>`).join("");
}
function renderKpis() {
  $("#kPipe").textContent = D.kpis.inPipeline; $("#kRend").textContent = D.kpis.rendering;
  $("#kNeed").textContent = D.kpis.needsYou; $("#kMtd").textContent = D.kpis.mtd;
}

/* ---------- inspector ---------- */
function closeInsp() { app.insp = null; $("#insp").style.display = "none"; app.space?.setActive(null); holdWalk(); }
function renderInsp() {
  const el = $("#insp");
  if (!app.insp) { el.style.display = "none"; return; }
  const d = app.insp, hue = HUE[d.state] || HUE.live;
  el.style.display = "block";
  el.innerHTML = `<aside style="position:relative;width:300px;padding:15px 15px 14px;background:var(--holo-plate);backdrop-filter:blur(14px);border:1px solid ${hexA(hue, .25)};border-radius:var(--r-s);box-shadow:0 0 34px ${hexA(hue, .16)}, inset 0 0 26px ${hexA(hue, .05)};display:flex;flex-direction:column;gap:11px">
    <i style="position:absolute;top:-1px;left:-1px;width:14px;height:14px;border-top:1px solid ${hue};border-left:1px solid ${hue}"></i>
    <i style="position:absolute;top:-1px;right:-1px;width:14px;height:14px;border-top:1px solid ${hue};border-right:1px solid ${hue}"></i>
    <i style="position:absolute;bottom:-1px;left:-1px;width:14px;height:14px;border-bottom:1px solid ${hue};border-left:1px solid ${hue}"></i>
    <i style="position:absolute;bottom:-1px;right:-1px;width:14px;height:14px;border-bottom:1px solid ${hue};border-right:1px solid ${hue}"></i>
    <header style="display:flex;align-items:flex-start;gap:9px">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
        <span style="font:500 13px/1.25 var(--font-body);color:var(--text-hud)">${d.title}</span>
        <span style="font:400 var(--t-hud-xs)/1 var(--font-mono);letter-spacing:.08em;color:${hue}">${d.id}</span>
      </div>
      <button id="inspClose" style="flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border-card);border-radius:var(--r-xs);color:var(--text-hud-mute);font:400 10px/1 var(--font-mono)">✕</button>
    </header>
    <div style="display:flex;flex-wrap:wrap;gap:5px">${d.chips.map((c, i) => i === 0 && d.state !== "idle" ? `<span style="font:500 8.5px/1 var(--font-mono);letter-spacing:.12em;padding:4px 8px;border-radius:99px;border:1px solid ${hexA(hue, .45)};background:${hexA(hue, .1)};color:${hue};white-space:nowrap">${c}</span>` : `<span style="font:500 8.5px/1 var(--font-mono);letter-spacing:.12em;padding:4px 8px;border-radius:99px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:rgba(232,234,237,.65);white-space:nowrap">${c}</span>`).join("")}</div>
    <dl style="margin:0;display:flex;flex-direction:column;border-top:1px solid rgba(255,255,255,.055)">${d.rows.map(([k, v, a]) => `<div style="display:flex;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.055)"><dt style="flex:none;width:92px;font:400 var(--t-hud-xxs)/1.4 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--text-hud-mute)">${k}</dt><dd style="margin:0;flex:1;min-width:0;font:400 var(--t-hud-s)/1.4 var(--font-mono);font-variant-numeric:tabular-nums;color:${a ? "var(--brass)" : "rgba(232,234,237,.8)"};overflow-wrap:anywhere">${v}</dd></div>`).join("")}</dl>
    <div style="display:flex;gap:8px;align-items:flex-start"><i style="flex:none;margin-top:4px;width:6px;height:6px;border-radius:99px;background:var(--violet);box-shadow:0 0 10px var(--violet)"></i><p id="inspNote" style="margin:0;font:400 var(--t-hud-s)/1.55 var(--font-mono);color:var(--text-hud-dim);min-height:2.8em"></p></div>
    <div style="display:flex;gap:7px">
      ${d.thread ? `<button id="inspThread" style="font:500 9.5px/1 var(--font-mono);letter-spacing:.12em;padding:8px 12px;border-radius:7px;border:1px solid var(--cyan-b);background:var(--cyan-tint);color:var(--cyan-lift)">OPEN THREAD</button>` : ""}
      ${d.rows.some(r => r[0] === "Action") ? `<button id="inspApprove" style="font:500 9.5px/1 var(--font-mono);letter-spacing:.12em;padding:8px 12px;border-radius:7px;border:1px solid var(--cyan-b);background:var(--cyan-tint);color:var(--cyan-lift)">APPROVE</button><button id="inspRevise" style="font:500 9.5px/1 var(--font-mono);letter-spacing:.12em;padding:8px 12px;border-radius:7px;border:1px solid var(--amber-b);background:var(--amber-tint);color:var(--amber)">REVISE</button>` : ""}
      <button id="inspDismiss" style="font:500 9.5px/1 var(--font-mono);letter-spacing:.12em;padding:8px 12px;border-radius:7px;border:1px solid var(--border-card);background:transparent;color:var(--text-hud-mute)">DISMISS</button>
    </div>
  </aside>`;
  $("#inspClose").onclick = closeInsp; $("#inspDismiss").onclick = closeInsp;
  if (d.thread) $("#inspThread").onclick = () => openThread(d.thread);
  if ($("#inspApprove")) $("#inspApprove").onclick = () => reviewAction(app.insp.nodeId, "approve");
  if ($("#inspRevise")) $("#inspRevise").onclick = () => reviewAction(app.insp.nodeId, "revise");
  setTimeout(() => type(d.note, $("#inspNote")), 60);
}
async function reviewAction(nodeId, action) {
  blip(action === "approve" ? 1400 : 700, 0.03, 0.09);
  const res = await callApi(`/api/review/${encodeURIComponent(nodeId)}`, { action });
  pushFeed("stage_change", `Review → ${nodeId} ${action === "approve" ? "approved" : "sent to revision"}${res.ok ? "" : " (offline)"}`);
  speak(action === "approve" ? "Approved. It ships tonight." : "Sent back for revision. I'll re-queue the render.", nodeId.toUpperCase());
  closeInsp();
}

/* ---------- threads ----------
 * One thread panel, one lead at a time (#threadPanel is a single DOM node —
 * opening a different lead reuses it rather than stacking a new one).
 * app.thread always carries the *complete* message history for that lead
 * (live-data.mjs now queries per-lead with no LIMIT), grouped visually by
 * consecutive same-direction runs in renderThread() below — grouping is a
 * layout treatment only, every message's full body is still rendered, never
 * truncated. */
function closeThread() { app.thread = null; $("#threadPanel").style.display = "none"; holdWalk(); }
function openThread(leadId) {
  const c = D.conversations.find((x) => x.leadId === leadId); if (!c) return;
  blip(1040, 0.02, 0.06);
  app.thread = { ...c, msgs: c.messages.slice() }; app.insp = null; renderInsp();
  renderThread();
  $("#threadPanel").style.display = "flex";
}
// Merge a freshly-polled conversation into the open thread without discarding
// an optimistic local send that the server hasn't reflected back yet: keep
// any locally-queued outbound message (time === "now") that isn't matched by
// an equivalent message already in the fresh history.
function mergeThreadMessages(fresh) {
  const t = app.thread;
  const freshKeys = new Set(fresh.messages.map((m) => `${m.dir}|${m.body}`));
  const pendingLocal = t.msgs.filter((m) => m.time === "now" && !freshKeys.has(`${m.dir}|${m.body}`));
  t.msgs = [...fresh.messages, ...pendingLocal];
  t.origin = fresh.origin; t.name = fresh.name;
}
// Consecutive same-direction messages collapse into one visual group (one
// header, tightly-stacked bubbles) — iMessage/Slack style. Purely layout: no
// message is summarized, merged, or trimmed, every body renders in full.
function groupMessages(msgs) {
  const groups = [];
  for (const m of msgs) {
    const last = groups[groups.length - 1];
    if (last && last.dir === m.dir) last.items.push(m);
    else groups.push({ dir: m.dir, who: m.who, items: [m] });
  }
  return groups;
}
function renderThread() {
  const t = app.thread; const p = $("#threadPanel");
  if (!t) { p.style.display = "none"; return; }
  // Preserve scroll position + whatever's mid-typed across a re-render — this
  // runs on every 5s live-data poll while a thread is open, so it must never
  // yank the panel out from under someone actively reading or composing.
  const prevMsgs = $("#msgs");
  const prevAtBottom = !prevMsgs || (prevMsgs.scrollTop + prevMsgs.clientHeight >= prevMsgs.scrollHeight - 40);
  const prevScroll = prevMsgs ? prevMsgs.scrollTop : 0;
  const prevInput = $("#composer");
  const prevDraft = prevInput ? prevInput.value : "";
  const hadFocus = document.activeElement === prevInput;
  const selStart = hadFocus ? prevInput.selectionStart : null, selEnd = hadFocus ? prevInput.selectionEnd : null;

  const originBadge = t.origin === "inbound"
    ? `<span style="font:500 7.5px/1 var(--font-mono);letter-spacing:.1em;padding:3px 7px;border-radius:99px;border:1px solid var(--cyan-b);background:var(--cyan-tint);color:var(--cyan-lift);white-space:nowrap">INBOUND LEAD</span>`
    : t.origin === "outbound"
    ? `<span style="font:500 7.5px/1 var(--font-mono);letter-spacing:.1em;padding:3px 7px;border-radius:99px;border:1px solid var(--brass-b);background:var(--brass-tint);color:var(--brass-lift);white-space:nowrap">OUTREACHED BY US</span>`
    : "";

  p.innerHTML = `
    <header style="flex:none;display:flex;align-items:center;gap:10px;padding:11px 13px;border-bottom:1px solid var(--border-panel);background:rgba(255,255,255,.014)">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
          <span style="font:500 13px/1.15 var(--font-body);color:var(--text-hud)">${escapeHtml(t.name)}</span>
          ${originBadge}
        </div>
        <div style="font:400 var(--t-hud-xs)/1 var(--font-mono);color:var(--text-hud-mute);margin-top:3px">${t.msgs.length} message${t.msgs.length === 1 ? "" : "s"} · full history</div>
      </div>
      <button id="aiToggle" style="display:flex;align-items:center;gap:6px;font:500 8.5px/1 var(--font-mono);letter-spacing:.12em;padding:6px 9px;border-radius:99px;white-space:nowrap;flex:none;border:1px solid ${app.aiReply ? "var(--violet-b)" : "var(--border-card)"};background:${app.aiReply ? "var(--violet-tint)" : "transparent"};color:${app.aiReply ? "var(--violet-lift)" : "var(--text-hud-mute)"}"><i style="width:5px;height:5px;border-radius:99px;background:currentColor;box-shadow:0 0 8px currentColor"></i>AUTO-REPLY ${app.aiReply ? "ON" : "OFF"}</button>
      <button id="threadClose" style="flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border-card);border-radius:var(--r-xs);color:var(--text-hud-mute);font:400 10px/1 var(--font-mono)">✕</button>
    </header>
    <div id="msgs" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px">
      ${groupMessages(t.msgs).map((g) => {
        const out = g.dir === "outbound";
        return `<div style="align-self:${out ? "flex-end" : "flex-start"};max-width:86%;display:flex;flex-direction:column;gap:3px">
          <div style="display:flex;gap:8px;align-items:baseline;padding:0 2px">
            <span style="font:500 8.5px/1 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:${out ? "var(--cyan-lift)" : "var(--text-hud-dim)"}">${escapeHtml(g.who)}</span>
            <span style="font:400 8.5px/1 var(--font-mono);color:var(--text-hud-mute)">${escapeHtml(g.items[0].time)}</span>
          </div>
          ${g.items.map((m) => `<div style="padding:9px 11px;border-radius:9px;border:1px solid ${out ? "rgba(52,224,208,.2)" : "rgba(255,255,255,.07)"};background:${out ? "rgba(52,224,208,.06)" : "rgba(255,255,255,.028)"}"><div style="font:400 12px/1.55 var(--font-body);color:var(--text-body);white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(m.body)}</div></div>`).join("")}
        </div>`;
      }).join("") || `<div style="font:400 11px/1.6 var(--font-mono);color:var(--text-hud-mute);padding:20px;text-align:center">No messages yet.</div>`}
    </div>
    <div style="flex:none;display:flex;gap:7px;padding:10px 12px;border-top:1px solid var(--border-panel);background:rgba(255,255,255,.014)">
      <input id="composer" placeholder="${app.aiReply ? "auto-reply is drafting — type to take over" : "Reply as devin"}" style="flex:1;min-width:0;background:rgba(255,255,255,.03);border:1px solid var(--border-card);border-radius:7px;color:var(--text-hud);font:400 11px/1.4 var(--font-mono);padding:9px 11px;outline:none">
      <button id="sendMsg" style="font:500 9.5px/1 var(--font-mono);letter-spacing:.14em;padding:0 14px;border-radius:7px;border:1px solid var(--cyan-b);background:var(--cyan-tint);color:var(--cyan-lift)">SEND</button>
    </div>`;
  $("#threadClose").onclick = closeThread;
  $("#aiToggle").onclick = async () => {
    const next = !app.aiReply;
    app.aiReply = next; renderThread();
    const res = await callApi(`/api/threads/${encodeURIComponent(t.leadId)}/auto`, { on: next });
    pushFeed("reply_mode", `AI ${next ? "on" : "off"} → ${t.name}${res.ok ? "" : " (offline — not persisted)"}`);
  };
  const send = async () => {
    const inp = $("#composer"); if (!inp.value.trim()) return;
    const body = inp.value.trim(); inp.value = "";
    app.thread.msgs.push({ dir: "outbound", who: "devin", time: "now", body });
    blip(1320, 0.025, 0.06); renderThread();
    const m = $("#msgs"); if (m) m.scrollTop = m.scrollHeight;
    const res = await callApi(`/api/threads/${encodeURIComponent(app.thread.leadId)}/reply`, { body });
    pushFeed("reply", `Reply → ${app.thread.name}${res.ok ? "" : " (offline — not sent)"}`);
    if (res.ok) speak(`Message sent to ${app.thread.name}.`, app.thread.leadId.toUpperCase());
  };
  $("#sendMsg").onclick = send;
  $("#composer").onkeydown = (e) => { if (e.key === "Enter") send(); };

  // Restore draft + caret + focus, then scroll: bottom if the reader was
  // already at the bottom (or this is the first open), otherwise hold position.
  const inp = $("#composer");
  if (inp) {
    inp.value = prevDraft;
    if (hadFocus) { inp.focus(); try { inp.setSelectionRange(selStart, selEnd); } catch {} }
  }
  requestAnimationFrame(() => { const m = $("#msgs"); if (m) m.scrollTop = prevAtBottom ? m.scrollHeight : prevScroll; });
}

/* ---------- voice / typewriter / audio ---------- */
let sayTimer = null;
function type(text, el) { el = el || $("#say"); clearInterval(sayTimer); let i = 0; sayTimer = setInterval(() => { i++; el.textContent = text.slice(0, i); if (i >= text.length) clearInterval(sayTimer); }, 22); }
// JARVIS-appropriate pick: a lower-pitched male English voice if the browser
// has one (Daniel/Arthur on Safari/macOS are the best case), otherwise any
// English voice. getVoices() can return [] before the browser has finished
// loading its voice list, so onvoiceschanged (wired in boot()) resets
// app.voice to undefined and this re-picks once the real list is in.
function pickVoice() {
  if (app.voice !== undefined) return app.voice;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return null; // not loaded yet — don't cache a bad "null" pick
  const en = (v) => /^en/i.test(v.lang);
  app.voice = vs.find((v) => en(v) && /daniel|arthur/i.test(v.name))
    || vs.find((v) => en(v) && /male|george|fred|alex/i.test(v.name))
    || vs.find((v) => /en.GB/i.test(v.lang))
    || vs.find(en)
    || null;
  return app.voice;
}
function setSpeaking(on) {
  app.speaking = on;
  $("#bar").style.borderColor = on ? "var(--violet-b)" : "var(--border-panel)";
  $("#bar").style.boxShadow = on ? "var(--glow-ai)" : "none";
  $("#barDot").style.animation = on ? "var(--pulse)" : "none";
  $("#wave").innerHTML = on
    ? [72,88,104,70,90,76,110,84,68].map((d, i) => `<i style="width:2px;height:16px;border-radius:1px;background:var(--violet-lift);animation:lx-wave ${d/100}s ease-in-out ${i*0.07}s infinite"></i>`).join("")
    : Array(9).fill('<i style="width:2px;height:4px;border-radius:1px;background:rgba(255,255,255,.16)"></i>').join("");
}
function speak(text, target, cb) {
  $("#tag").style.display = target ? "block" : "none"; $("#tag").textContent = target || "";
  setSpeaking(true); type(text);
  const done = () => { setSpeaking(false); cb?.(); };
  if (app.audioOn && "speechSynthesis" in window) {
    // Calm, measured, unhurried — slightly below default rate/pitch rather
    // than the chirpy default TTS cadence. No single "right" number here;
    // tuned by ear for a dry, understated JARVIS delivery.
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 0.92; u.pitch = 0.88; const v = pickVoice(); if (v) u.voice = v; u.onend = done; u.onerror = done; speechSynthesis.speak(u); return; } catch {}
  }
  clearTimeout(app._estT); app._estT = setTimeout(done, Math.max(3200, text.length * 52));
}
// Ambient narration queue for the live activity feed — speak() drives the
// visible "say" ticker + optional voice for one line at a time; this just
// makes sure back-to-back feed events don't cut each other off. Polled
// rather than callback-chained because speak() also gets called directly
// from a dozen other places (node select, sitrep, reviews...) that don't
// know about this queue.
function pumpVoiceQueue() {
  if (app.speaking || !app.voiceQueue.length) return;
  const next = app.voiceQueue.shift();
  speak(next.text, next.tag);
}
setInterval(pumpVoiceQueue, 2000);
// Best-effort name lookup for a raw lead/order id embedded in a DB activity
// message (e.g. "Reply mode → <uuid>") — checks the dossiers the live snapshot
// already keyed by id / lead_<id> / order_<id> so ambient narration can say a
// name instead of reading a UUID aloud.
function lookupName(rawId) {
  if (!rawId) return null;
  const id = rawId.trim();
  return D.dossiers[id]?.title || D.dossiers[`lead_${id}`]?.title || D.dossiers[`order_${id}`]?.title || null;
}
// Turns a raw DB activity-feed row into a short, natural spoken line. Falls
// back to the raw message for kinds without a specific phrasing (ids/template
// names don't always read well aloud, but reading *something* beats silence
// for kinds we haven't hand-tuned). Returning null means "don't narrate this
// one" — routine/internal events that would just add noise.
function speakable(entry) {
  const msg = entry.message || "";
  const arrowId = (msg.match(/→\s*([\w-]{6,})/) || [])[1];
  const name = lookupName(arrowId);
  switch (entry.kind) {
    case "reply": return `You have a new reply${name ? ` from ${name}` : ""}.`;
    case "escalation": return /resolved/i.test(msg) ? "An escalation has been resolved." : `${name || "A lead"} has been escalated for a human.`;
    case "call": { const m = msg.match(/^Call with (.+?) —\s*(.+)$/); return m ? `Call with ${m[1]}. Outcome: ${m[2]}.` : msg; }
    case "call_placed": return `A voice call has been placed${name ? ` to ${name}` : ""}.`;
    case "stage_change":
      if (/delivered/i.test(msg)) return `${name || "An order"} has been delivered.`;
      if (/review/i.test(msg)) return `${name || "An order"} is waiting at review.`;
      if (/awaiting_photos/i.test(msg)) return `${name || "An order"} is awaiting photos.`;
      return msg;
    case "lead_run": return "The lead hunt has finished a pass.";
    case "outbound_batch": { const m = msg.match(/(\d+) sent, (\d+) skipped/); return m ? `Outreach batch complete. ${m[1]} sent, ${m[2]} skipped.` : msg; }
    case "render_queued": return `${name || "A render"} has been queued.`;
    case "render_retry": return "A render failed quality control and is retrying.";
    case "demo_queued": return "A demo render has been queued.";
    case "revision_requested": return `${name || "An order"} was sent back for revision.`;
    case "hunter_note": case "hunter_source_error": case "outbox": case "reply_mode": case "scheduler_error":
      return null; // internal/routine — too chatty to narrate every 5s poll
    default: return msg;
  }
}
function enableAudio() {
  if (app.ac) return;
  try {
    app.ac = new (window.AudioContext || window.webkitAudioContext)();
    const g = app.ac.createGain(); g.gain.value = 0; g.connect(app.ac.destination); app.master = g;
    const lp = app.ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 260; lp.connect(g);
    [[54, "triangle", 0.16], [108.4, "sine", 0.09], [162.2, "sine", 0.03]].forEach(([f, t, v]) => { const o = app.ac.createOscillator(), og = app.ac.createGain(); o.type = t; o.frequency.value = f; og.gain.value = v; o.connect(og); og.connect(lp); o.start(); });
    const lfo = app.ac.createOscillator(), lg = app.ac.createGain(); lfo.frequency.value = 0.06; lg.gain.value = 0.03; lfo.connect(lg); lg.connect(g.gain); lfo.start();
    g.gain.linearRampToValueAtTime(0.09, app.ac.currentTime + 2.5);
    app.audioOn = true; updateAudioBtn(); blip(660, 0.03, 0.12);
  } catch {}
}
function toggleAudio() {
  if (!app.ac) return enableAudio();
  if (app.audioOn) { app.master.gain.linearRampToValueAtTime(0, app.ac.currentTime + 0.3); try { speechSynthesis.cancel(); } catch {} app.audioOn = false; setSpeaking(false); }
  else { app.master.gain.linearRampToValueAtTime(0.09, app.ac.currentTime + 0.5); app.audioOn = true; }
  updateAudioBtn();
}
function updateAudioBtn() { const b = $("#audioBtn"); b.textContent = app.audioOn ? "AUDIO ON" : "AUDIO OFF"; b.className = "pill" + (app.audioOn ? " cyan" : ""); }
function blip(f, v, d) {
  if (!app.ac || !app.audioOn) return;
  const t = app.ac.currentTime; const o = app.ac.createOscillator(), g = app.ac.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.62, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g); g.connect(app.ac.destination); o.start(t); o.stop(t + d + 0.02);
}

/* ---------- walk / sitrep / commands ---------- */
let nextT, resumeT;
function stepWalk() {
  if (app.paused) return;
  const s = D.script[app.walkIdx % D.script.length]; app.walkIdx++;
  app.space.setActive(s.target); app.space.focusNode(s.target);
  speak(s.text, s.target.toUpperCase(), () => { nextT = setTimeout(stepWalk, 2400); });
}
function holdWalk() { clearTimeout(nextT); clearTimeout(resumeT); resumeT = setTimeout(() => { if (!app.paused && !app.insp && !app.thread) stepWalk(); }, 26000); }
function togglePause() {
  app.paused = !app.paused; $("#pauseBtn").textContent = app.paused ? "RESUME" : "PAUSE";
  if (app.paused) { clearTimeout(nextT); try { speechSynthesis.cancel(); } catch {} setSpeaking(false); type("Narration paused. The map is yours."); }
  else stepWalk();
}
function sitrep() {
  const k = D.kpis, o = D.outbox; blip(880, 0.03, 0.09);
  speak(`Sitrep. ${k.inPipeline} in pipeline, ${k.rendering} rendering, ${k.needsYou} needs you. ${k.mtd} month to date. Outbox — ${o.queued} queued, ${o.sentToday} sent, ${o.failed} failed. Review gate holds Villa Alba.`, "SITREP");
  holdWalk();
}
async function triggerHunt() {
  blip(1500, 0.03, 0.1);
  const res = await callApi("/api/leadhunt");
  pushFeed("lead_run", `Lead hunt triggered${res.ok ? "" : " (offline — not started)"}`);
  speak("Lead hunt triggered. I'll report back with what qualifies.", "LEADHUNT");
}
// Opens a node's inspector without speaking its note — used by the report
// helpers below, which compose their own spoken summary instead of reading
// the node's static dossier note aloud.
function openNodeSilent(id) {
  const d = D.dossiers[id]; if (!d) return null;
  app.space.setActive(id); app.space.focusNode(id);
  app.insp = { nodeId: id, ...d }; renderInsp();
  return d;
}
function onSelect(id) {
  const d = openNodeSilent(id); if (!d) return;
  blip(880, 0.025, 0.07); holdWalk();
  speak(d.note, (d.id || id).toUpperCase());
}
// Most relevant lead_* node to jump to for an "any pending replies" style
// query: prefer one actually needing a human (escalated/attention), then any
// live conversation, then anything hot at all. Real ids, not a hardcoded demo lead.
function findHotLead() {
  return D.nodes.find((n) => n.id.startsWith("lead_") && n.state === "attention")
    || D.nodes.find((n) => n.id.startsWith("lead_") && n.parent === "conversations")
    || D.nodes.find((n) => n.id.startsWith("lead_"))
    || null;
}
function rowVal(dossier, label) { return dossier?.rows.find((r) => r[0] === label)?.[1]; }
// "How's lead gen going" / "where are leads sitting" — a stage-by-stage
// breakdown pulled from the live dossiers already built by live-data.mjs,
// not a separate query.
function leadGenReport() {
  blip(880, 0.03, 0.09);
  const leads = openNodeSilent("leads");
  const newCt = rowVal(leads, "New") ?? "0";
  const contactedCt = rowVal(D.dossiers.outreach, "Contacted") ?? "0";
  const repliedCt = rowVal(D.dossiers.conversations, "Replied") ?? "0";
  const bookedCt = rowVal(D.dossiers.call_booked, "Call booked") ?? "0";
  speak(`Lead gen. ${newCt} new and uncontacted, ${contactedCt} contacted and waiting on a reply, ${repliedCt} in active conversation, ${bookedCt} with a call booked.`, "LEAD GEN");
}
// "Any pending replies" / "where are messages sitting" — surfaces the count
// and jumps straight to the most relevant open conversation.
function pendingRepliesReport() {
  blip(880, 0.03, 0.09);
  const conv = openNodeSilent("conversations");
  const repliedCt = Number(rowVal(conv, "Replied") ?? 0);
  const escalatedCt = Number(rowVal(conv, "Escalated") ?? 0);
  const lead = findHotLead();
  if (!repliedCt && !escalatedCt) { speak("No pending replies right now — every conversation is caught up.", "REPLIES"); return; }
  const bits = [`${repliedCt} repl${repliedCt === 1 ? "y is" : "ies are"} waiting on you`];
  if (escalatedCt) bits.push(`${escalatedCt} escalated for a human`);
  speak(`${bits.join(", ")}.${lead ? ` Most recent: ${lead.label}.` : ""}`, "REPLIES");
  if (lead) setTimeout(() => openThread(lead.id), 900);
}
function resetView() { app.space?.resetView(); app.insp = null; renderInsp(); holdWalk(); }
function command(raw) {
  const t = raw.toLowerCase(); type(`heard — ${raw}`); holdWalk();
  const go = (id) => setTimeout(() => onSelect(id), 700);

  // --- job control: these actually act on browser_jobs/orders in Supabase,
  // not just switch what's on screen. Checked first so e.g. "approve" isn't
  // swallowed by a node-name match. ---
  if (/\b(hunt|find (more )?leads|scrape|search the market)\b/.test(t)) return setTimeout(triggerHunt, 700);
  if (/\bapprove\b/.test(t) && app.insp) return setTimeout(() => reviewAction(app.insp.nodeId, "approve"), 700);
  if (/\b(revise|reject|send (it |this )?back)\b/.test(t) && app.insp) return setTimeout(() => reviewAction(app.insp.nodeId, "revise"), 700);

  // --- status queries: read-only summaries composed from the live snapshot ---
  if (/pending repl|awaiting reply|any repl|unanswered|repl(y|ies).*(waiting|sitting|pending)/.test(t)) return setTimeout(pendingRepliesReport, 700);
  if (/lead gen|new leads|leads?.*(sitting|going|doing)|where.*leads/.test(t)) return setTimeout(leadGenReport, 700);
  if (t.includes("sitrep") || t.includes("status") || t.includes("report") || t.includes("stats") || t.includes("pipeline")) return setTimeout(sitrep, 700);

  if (t.includes("pause") || t.includes("hold")) { if (!app.paused) togglePause(); return; }
  if (t.includes("resume") || t.includes("continue")) { if (app.paused) togglePause(); return; }
  if (t.includes("reset") || t.includes("overview") || t.includes("zoom out")) return resetView();
  if (t.includes("mute")) { if (app.audioOn) toggleAudio(); return; }
  if (t.includes("thread") || t.includes("messages")) { const lead = findHotLead(); return openThread(app.insp?.thread || lead?.id); }
  const map = [["review", ["review", "gate"]], ["generating", ["generat", "render"]], ["outbox", ["outbox", "queue"]], ["outreach", ["outreach"]], ["conversations", ["conversation"]], ["leads", ["lead"]], ["orders", ["paid", "order"]], ["delivered", ["deliver"]], ["core", ["jarvis", "core", "center"]]];
  for (const [id, keys] of map) if (keys.some(k => t.includes(k))) return go(id);
  type(`heard — ${raw} · no match. Try lead gen, pending replies, sitrep, or a node name.`);
}
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return type("Voice input is not available in this browser.");
  if (app.micOn) { try { app._rec.stop(); } catch {} app.micOn = false; updateMicBtn(); return; }
  const r = app._rec = new SR(); r.lang = "en-US"; r.interimResults = false; r.maxAlternatives = 1;
  r.onresult = (e) => command(e.results[0][0].transcript);
  r.onend = () => { app.micOn = false; updateMicBtn(); };
  r.onerror = () => { app.micOn = false; updateMicBtn(); };
  try { r.start(); app.micOn = true; updateMicBtn(); type("Listening."); blip(1560, 0.03, 0.07); } catch {}
}
function updateMicBtn() { const b = $("#micBtn"); b.textContent = app.micOn ? "◉ LISTENING" : "◉ PUSH TO TALK"; b.className = "pill" + (app.micOn ? " red" : ""); }

/* ---------- frame loop (camera/radar readouts) ---------- */
function frame() {
  requestAnimationFrame(frame);
  if (!app.space?.ready) return;
  app._radT = (app._radT || 0) + 1;
  if (app._radT % 10 === 0) {
    const blips = app.space.getRadar();
    $("#radar").innerHTML = blips.map((b) => { const r = 8 + b.d * 58, x = 74 + Math.sin(b.ang) * r, y = 74 - Math.cos(b.ang) * r, s = b.active ? 5 : 3; return `<i style="position:absolute;left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${s}px;height:${s}px;margin:-2px;border-radius:99px;background:${b.hue};box-shadow:0 0 ${b.active ? 10 : 5}px ${b.hue}"></i>`; }).join("");
    const c = app.space.getCamera(); const line = `AZ ${c.az.toFixed(1)}° · EL ${c.el.toFixed(1)}° · R ${c.dist.toFixed(0)}`;
    $("#camline").textContent = line; $("#corner").textContent = "CAM " + line;
  }
  if (app.insp && $("#insp").style.display !== "none") {
    const p = app.space.getScreenPos(app.insp.nodeId);
    if (p) { const W = innerWidth, H = innerHeight; let x = p.x + p.r + 28, y = p.y - 130; if (p.x > W * 0.56) x = p.x - p.r - 28 - 300; x = Math.max(244, Math.min(W - 314, x)); y = Math.max(62, Math.min(H - 340, y)); $("#insp").style.transform = `translate(${x.toFixed(0)}px,${y.toFixed(0)}px)`; $("#insp").style.opacity = p.behind ? "0" : "1"; }
  }
  // Thread panel anchor line: a thin line + pulsing dot from the selected
  // node's live screen position to the panel, so the expanded conversation
  // reads as spatially anchored to that node rather than a floating, separate
  // UI element — the panel itself stays in its fixed dock (matches the
  // existing inspector-panel pattern), the connector is what ties them together.
  const anchorLine = $("#anchorLine"), anchorDot = $("#anchorDot");
  if (anchorLine && app.thread && $("#threadPanel").style.display !== "none") {
    const p = app.space.getScreenPos(app.thread.leadId);
    const panel = $("#threadPanel");
    if (p && !p.behind && panel) {
      const rect = panel.getBoundingClientRect();
      const px = rect.left, py = Math.max(rect.top + 24, Math.min(rect.bottom - 24, p.y));
      anchorLine.setAttribute("x1", p.x.toFixed(1)); anchorLine.setAttribute("y1", p.y.toFixed(1));
      anchorLine.setAttribute("x2", px.toFixed(1)); anchorLine.setAttribute("y2", py.toFixed(1));
      anchorLine.setAttribute("opacity", "0.55");
      anchorDot.setAttribute("cx", p.x.toFixed(1)); anchorDot.setAttribute("cy", p.y.toFixed(1)); anchorDot.setAttribute("opacity", "0.9");
    } else { anchorLine.setAttribute("opacity", "0"); anchorDot.setAttribute("opacity", "0"); }
  } else if (anchorLine) { anchorLine.setAttribute("opacity", "0"); anchorDot.setAttribute("opacity", "0"); }
}

/* ---------- boot ---------- */
function boot() {
  renderKpis(); renderAgents(); renderOutbox(); renderFeed(); updateAudioBtn(); updateMicBtn(); setSpeaking(false);
  const clock = () => $("#clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
  clock(); setInterval(clock, 1000);
  pollState(); setInterval(pollState, 5000);
  pollLiveData(); setInterval(pollLiveData, 5000);
  setInterval(() => { if (!app.paused && D.events.length) { const e = D.events[app.evIdx % D.events.length]; app.evIdx++; pushFeed(e.kind, e.message); app.space?.pulseNode(e.target); blip(660, 0.018, 0.09); if (!app.speaking) speak(e.say, e.target.toUpperCase()); } }, 22000);
  // getVoices() is often empty until the browser finishes loading its voice
  // list; re-pick once it fires instead of caching a premature "no voice found".
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => { app.voice = undefined; };

  $("#sitrepBtn").onclick = sitrep; $("#pauseBtn").onclick = togglePause; $("#resetBtn").onclick = resetView;
  $("#micBtn").onclick = toggleMic; $("#audioBtn").onclick = toggleAudio; $("#huntBtn").onclick = triggerHunt;
  $("#cmdInput").onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim(); if (!v) return;
    e.target.value = ""; command(v);
  };
  window.addEventListener("pointerdown", function unlock() { enableAudio(); window.removeEventListener("pointerdown", unlock); }, { once: true });

  const sp = document.getElementById("space");
  sp.addEventListener("space-ready", () => {
    app.space = sp; sp.setData({ nodes: D.nodes, links: D.links }); sp.setQuality("cinematic");
    sp.addEventListener("node-select", (e) => onSelect(e.detail.id));
    sp.addEventListener("node-hover", (e) => { if (e.detail.id) blip(1240, 0.018, 0.05); });
    sp.addEventListener("user-interact", holdWalk);
    setTimeout(() => { $("#boot").style.display = "none"; type("All systems online. Thirty-four in pipeline — one gate needs you."); setTimeout(stepWalk, 3000); }, 500);
  });
  frame();
}
boot();

/* ---------- native bridge ----------
 * Called from Mark-L's PyQt6 shell (ui.py's MindMapView, via
 * page().runJavaScript) when this dashboard is embedded as JARVIS's actual
 * window instead of viewed as a standalone page. Visual sync only — never
 * triggers browser TTS, since the real voice is already playing from Gemini
 * Live through the system speakers on the Python side. */
window.__jarvisBridge = {
  setState(state) {
    setSpeaking(state === "SPEAKING");
    const busy = state === "THINKING" || state === "MUTED" || state === "SLEEPING";
    $("#tag").style.display = busy ? "block" : "none";
    if (busy) $("#tag").textContent = state;
  },
  say(text) {
    holdWalk();
    setSpeaking(true);
    type(text);
    clearTimeout(app._bridgeSayT);
    app._bridgeSayT = setTimeout(() => setSpeaking(false), Math.max(1800, text.length * 45));
  },
};

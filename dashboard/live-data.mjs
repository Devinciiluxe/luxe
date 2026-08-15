// Builds the MJ3-shaped object from DATABASE_URL/pg.
//
// ⚠ UNUSED ON THE ROOT DEMO SURFACE — there is no server.mjs here; npm start
// refuses. Do NOT wire this back into dashboard/public. Live pipeline numbers
// come from luxe-cortex (/cortex, Supabase + EventSource). Keeping this file
// only as a historical reference for the MJ3 shape.
import pg from 'pg';

const { Pool } = pg;
let pool = null;
function db() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
  pool.on('error', (err) => console.error('[jarvis live-data] pool error:', err.message));
  return pool;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

// Same stage-derivation convention luxe-dashboard/src/lib/pipeline.ts used:
// stale > 72h -> stuck, escalated -> attention, otherwise live/idle/value.
function leadState(lead) {
  if (lead.status === 'escalated') return 'attention';
  if (lead.status === 'lost') return 'idle';
  if (hoursSince(lead.updated_at) > 72 && ['contacted', 'replied', 'call_booked'].includes(lead.status)) return 'stuck';
  if (lead.status === 'closed') return 'value';
  return 'live';
}
function orderState(order) {
  if (order.stage === 'review') return 'attention';
  if (order.stage === 'failed') return 'stuck';
  if (order.stage === 'delivered') return 'value';
  return 'live';
}

// Who reached out first: prefer the leads.contact_route column (authoritative —
// set at lead-creation time) over inferring from message order. 'inbound' means
// the lead contacted us first (e.g. a contact form or platform DM they started).
// Any other non-empty contact_route (airbnb_platform, booking_site,
// published_direct, brokerage_site, inmail, referral, ...) means we found and
// reached them first. Zero outbound messages ever sent is an unambiguous
// inbound signal regardless of contact_route or lead status, so that check
// wins first. Message order is only the fallback when contact_route is unset.
function outreachOrigin(lead, msgs) {
  if (msgs.length && !msgs.some((m) => m.direction === 'outbound')) return 'inbound';
  if (lead.contact_route === 'inbound') return 'inbound';
  if (lead.contact_route) return 'outbound';
  if (msgs.length) return msgs[0].direction === 'inbound' ? 'inbound' : 'outbound';
  return 'unknown';
}

export async function buildLiveState() {
  const q = (text, params = []) => db().query(text, params);

  const [
    leadCounts, orderCounts, videoCounts, escCount,
    hotLeads, hotOrders, hotVideo, mtd, recentActivity,
  ] = await Promise.all([
    q(`SELECT status, count(*) AS n FROM leads GROUP BY status`),
    q(`SELECT stage, count(*) AS n FROM orders GROUP BY stage`),
    q(`SELECT status, count(*) AS n FROM video_jobs GROUP BY status`),
    q(`SELECT count(*) AS n FROM escalations WHERE resolved = 0`),
    // Every lead that has actually engaged — not the full 2,500+ pipeline (most
    // have never replied). No hard cap in practice: this is dozens today and
    // grows slowly, LIMIT 500 is just a safety ceiling against a runaway count.
    q(`SELECT id, first_name, last_name, property_name, status, updated_at, track, contact_route
         FROM leads WHERE status IN ('replied','escalated','call_booked','qualified') ORDER BY updated_at DESC LIMIT 500`),
    q(`SELECT id, property_name, property_address, tier, stage, amount, stage_updated_at
         FROM orders WHERE stage IN ('review','generating') ORDER BY stage_updated_at DESC LIMIT 300`),
    q(`SELECT id, order_id, kind, status, submitted_at FROM video_jobs
         WHERE status IN ('queued','generating','rendering','postprocessing','uploading')
         ORDER BY submitted_at DESC LIMIT 6`),
    q(`SELECT coalesce(sum(amount), 0) AS total FROM orders
         WHERE delivered_at <> '' AND delivered_at >= date_trunc('month', now())::text`),
    q(`SELECT kind, message, created_at FROM activity ORDER BY created_at DESC LIMIT 26`),
  ]);

  // Full message history for exactly the hot leads above — not a shared,
  // globally-limited pool. A global "last 40 messages" query would silently
  // clip an individual lead's thread once other leads' traffic pushed their
  // messages out of the window, so this queries per-lead, unbounded, and only
  // for the leads we're actually showing. Ascending so callers get
  // oldest-first chat order without a separate reverse() step.
  const hotLeadIds = hotLeads.rows.map((r) => r.id);
  const recentMsgs = hotLeadIds.length
    ? await q(`SELECT lead_id, direction, body, created_at FROM messages WHERE lead_id = ANY($1) ORDER BY created_at ASC`, [hotLeadIds])
    : { rows: [] };
  const msgsByLead = new Map();
  for (const m of recentMsgs.rows) {
    if (!msgsByLead.has(m.lead_id)) msgsByLead.set(m.lead_id, []);
    msgsByLead.get(m.lead_id).push(m);
  }

  const byStatus = Object.fromEntries(leadCounts.rows.map((r) => [r.status, Number(r.n)]));
  const byStage = Object.fromEntries(orderCounts.rows.map((r) => [r.stage, Number(r.n)]));
  const byVideo = Object.fromEntries(videoCounts.rows.map((r) => [r.status, Number(r.n)]));
  const needsYou = Number(escCount.rows[0]?.n || 0) + (byStage.review || 0);
  const rendering = ['queued', 'generating', 'rendering', 'postprocessing', 'uploading'].reduce((s, k) => s + (byVideo[k] || 0), 0);
  const inPipeline = ['new', 'contacted', 'replied', 'qualified', 'call_booked'].reduce((s, k) => s + (byStatus[k] || 0), 0);
  const mtdTotal = Number(mtd.rows[0]?.total || 0);

  const nodes = [
    { id: 'core', parent: null, r: 16, state: 'ai', label: 'Jarvis', sublabel: `${inPipeline} in pipeline · live data` },
    { id: 'leads', parent: 'core', r: 9, state: (byStatus.new || 0) > 0 ? 'idle' : 'idle', label: 'Leads found', sublabel: 'new, uncontacted', count: byStatus.new || 0 },
    { id: 'outreach', parent: 'core', r: 9, state: 'live', label: 'Outreach', sublabel: 'contacted, awaiting reply', count: byStatus.contacted || 0 },
    { id: 'conversations', parent: 'core', r: 10, state: needsYou > 0 ? 'attention' : 'live', label: 'Conversations', sublabel: `${byStatus.replied || 0} replied`, count: (byStatus.replied || 0) + (byStatus.qualified || 0) },
    { id: 'call_booked', parent: 'core', r: 9, state: (byStatus.call_booked || 0) > 0 ? 'live' : 'idle', label: 'Call booked', sublabel: 'voice agent closing', count: byStatus.call_booked || 0 },
    { id: 'orders', parent: 'core', r: 9, state: 'value', label: 'Paid', sublabel: 'awaiting photos / coverage', count: (byStage.paid || 0) + (byStage.awaiting_photos || 0) + (byStage.coverage_check || 0) },
    { id: 'generating', parent: 'core', r: 10.5, state: rendering > 0 ? 'live' : 'idle', label: 'Generating', sublabel: 'higgsfield render', count: rendering },
    { id: 'review', parent: 'core', r: 9, state: (byStage.review || 0) > 0 ? 'attention' : 'idle', label: 'Review', sublabel: 'gate · needs you', count: byStage.review || 0 },
    { id: 'delivered', parent: 'core', r: 9, state: 'value', label: 'Delivered', sublabel: `$${mtdTotal.toLocaleString()} mtd`, count: byStage.delivered || 0 },
  ];
  const dossiers = {
    core: { title: 'Jarvis', id: 'MISSION CONTROL', state: 'ai', chips: ['LIVE'], rows: [['In pipeline', String(inPipeline)], ['Needs you', String(needsYou)], ['Data', 'Supabase · live']], note: 'Live data, wired directly to the leads/orders/messages tables.' },
    leads: { title: 'Leads found', id: 'STAGE 01', state: 'idle', chips: [`${byStatus.new || 0} NEW`], rows: [['New', String(byStatus.new || 0)], ['Contacted', String(byStatus.contacted || 0)]], note: 'Leads not yet contacted by outreach.' },
    outreach: { title: 'Outreach', id: 'STAGE 02', state: 'live', chips: ['LIVE'], rows: [['Contacted', String(byStatus.contacted || 0)]], note: 'Contacted, waiting on a reply.' },
    conversations: { title: 'In conversation', id: 'STAGE 03', state: needsYou > 0 ? 'attention' : 'live', chips: [`${byStatus.replied || 0} REPLIED`], rows: [['Replied', String(byStatus.replied || 0)], ['Qualified', String(byStatus.qualified || 0)], ['Escalated', String(escCount.rows[0]?.n || 0)]], note: 'Real inbound replies from leads.' },
    call_booked: { title: 'Call booked', id: 'STAGE 04', state: (byStatus.call_booked || 0) > 0 ? 'live' : 'idle', chips: [`${byStatus.call_booked || 0} BOOKED`], rows: [['Call booked', String(byStatus.call_booked || 0)]], note: 'Voice agent has a call scheduled to close — src/voice/dialer.js.' },
    orders: { title: 'Paid', id: 'STAGE 05', state: 'value', chips: ['PAID'], rows: [['Paid', String(byStage.paid || 0)], ['Awaiting photos', String(byStage.awaiting_photos || 0)], ['Coverage check', String(byStage.coverage_check || 0)]], note: 'Real Square payments in the fulfillment pipeline.' },
    generating: { title: 'Generating', id: 'STAGE 06', state: rendering > 0 ? 'live' : 'idle', chips: ['HIGGSFIELD'], rows: [['Rendering', String(rendering)]], note: 'Video jobs currently in flight at Higgsfield.' },
    review: { title: 'Review', id: 'GATE', state: (byStage.review || 0) > 0 ? 'attention' : 'idle', chips: ['NEEDS YOU'], rows: [['Waiting', String(byStage.review || 0)]], note: 'Renders holding at the human review gate.' },
    delivered: { title: 'Delivered', id: 'STAGE 08', state: 'value', chips: ['MTD'], rows: [['This month', `$${mtdTotal.toLocaleString()}`], ['Total delivered', String(byStage.delivered || 0)]], note: 'Real delivered orders this month.' },
  };
  const links = [
    ['leads', 'outreach'], ['outreach', 'conversations'], ['conversations', 'call_booked'], ['call_booked', 'orders'],
    ['orders', 'generating'], ['generating', 'review'], ['review', 'delivered'],
  ];

  for (const lead of hotLeads.rows) {
    const id = `lead_${lead.id}`;
    const label = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.property_name || lead.id.slice(0, 8);
    const parent = lead.status === 'call_booked' ? 'call_booked' : 'conversations';
    const msgs = msgsByLead.get(lead.id) || [];
    const origin = outreachOrigin(lead, msgs);
    nodes.push({ id, parent, r: 5, state: leadState(lead), label, sublabel: lead.property_name || lead.track });
    dossiers[id] = {
      title: label, id: `LEAD · ${lead.status}`, state: leadState(lead),
      chips: [lead.status.toUpperCase(), lead.track?.toUpperCase() || ''].filter(Boolean),
      rows: [['Property', lead.property_name || '—'], ['Status', lead.status], ['Origin', origin === 'inbound' ? 'Inbound lead' : origin === 'outbound' ? 'Outreached by us' : 'Unknown'], ['Updated', lead.updated_at]],
      note: lead.status === 'escalated' ? 'Escalated — needs a human.' : lead.status === 'call_booked' ? 'Voice agent has a call booked with this lead.' : 'Real inbound reply from this lead.',
      thread: id,
    };
  }
  for (const o of hotOrders.rows) {
    const id = `order_${o.id}`;
    const parent = o.stage === 'review' ? 'review' : 'generating';
    nodes.push({ id, parent, r: 5, state: orderState(o), label: o.property_name || o.id.slice(0, 8), sublabel: `${o.tier} · $${Number(o.amount).toLocaleString()}` });
    dossiers[id] = {
      title: o.property_name || o.property_address || o.id, id: `ORDER · ${o.tier}`, state: orderState(o),
      chips: [o.tier?.toUpperCase(), `$${Number(o.amount).toLocaleString()}`].filter(Boolean),
      rows: [['Stage', o.stage], ['Updated', o.stage_updated_at]],
      note: o.stage === 'review' ? 'Holding at the human review gate — approve or revise.' : 'Currently rendering.',
    };
  }

  // Full history, oldest first, for every hot lead — msgsByLead was built above
  // from the unbounded per-lead query, so nothing here is clipped by a global cap.
  const conversations = [];
  for (const lead of hotLeads.rows) {
    const id = `lead_${lead.id}`;
    const msgs = msgsByLead.get(lead.id) || [];
    conversations.push({
      leadId: id,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.property_name || lead.id,
      origin: outreachOrigin(lead, msgs),
      messages: msgs.map((m) => ({ dir: m.direction, who: m.direction === 'outbound' ? 'devin' : (lead.first_name || 'lead'), time: m.created_at, body: m.body })),
    });
  }

  const feed = recentActivity.rows.map((a) => ({
    time: new Date(a.created_at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }),
    kind: a.kind, message: a.message,
  }));

  const workers = [
    { name: 'higgsfield', busy: rendering > 0, status: rendering > 0 ? `${rendering} render(s) in flight` : 'idle' },
    { name: 'lead-hunter', busy: false, status: 'runs on schedule · watches active markets' },
    { name: 'outreach-writer', busy: false, status: 'drafts on new replies' },
    { name: 'fulfillment', busy: false, status: 'watches Square + photo uploads' },
    { name: 'sales-optimizer', busy: false, status: 'weekly pass over calls + messages' },
  ];

  return {
    meta: { system: 'MISSION JARVIS', version: 'live' },
    kpis: { inPipeline, rendering, needsYou, mtd: `$${mtdTotal.toLocaleString()}` },
    workers,
    outbox: { queued: 0, sending: 0, sentToday: 0, cap: 40, failed: 0, retry: 0, channels: [], queue: [] },
    feed,
    nodes, links, dossiers, conversations,
    script: [],
    events: [],
  };
}

// The HUD rails of the command center: left lead/event log, right analytics
// stack. All client components — data arrives as props from useCortex().
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Lead, LogEvent, Metrics, Stage } from "../lib/types";
import { STAGE_LABEL } from "../lib/types";
import { AMBER, CYAN, MAGENTA, money, tstamp } from "../lib/utils";

/* ---------------- left rail: hunter log + sparkline ---------------- */

export function HunterLog({ events }: { events: LogEvent[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="hud-title">Activity log</span>
        <span className="chip chip-cyan" title="Supabase activity table">LIVE · SUPABASE</span>
      </div>
      <div className="feed flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {events.map((e) => (
          <div key={e.id} className="msg-in flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/[0.03]">
            <LogIcon icon={e.icon} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] leading-4 text-[#c8d4de]">{e.text}</div>
              <div className="font-mono text-[9px] tracking-wider text-[#5c6b78]">{tstamp(e.createdAt)}</div>
            </div>
            {e.datum ? (
              <span className="font-mono text-[10px] font-semibold text-[#9be8f0]">{e.datum}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function LogIcon({ icon }: { icon: LogEvent["icon"] }) {
  if (icon === "warn")
    return (
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-[#ff9f43]" fill="currentColor">
        <path d="M8 1.5 15 14H1L8 1.5Zm0 4.5v3.5m0 1.8v.2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (icon === "lead")
    return (
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-[#ff007f]" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="8" cy="8" r="3.2" />
        <circle cx="8" cy="8" r="6.5" opacity="0.4" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-[#00f2fe]" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="6.2" opacity="0.5" />
      <path d="m5 8.2 2 2 4-4.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Sparkline({ events }: { events: LogEvent[] }) {
  // Derive a 24-bucket activity series from event timestamps.
  const points = useMemo(() => {
    const buckets = new Array(24).fill(0);
    const now = Math.floor(Date.now() / 1000);
    const span = 24 * 60 * 60;
    for (const e of events) {
      const dt = now - e.createdAt;
      if (dt < 0 || dt > span) continue;
      buckets[23 - Math.floor((dt / span) * 24)]++;
    }
    // Smooth it a touch so a log-free hour still draws a line.
    const out: number[] = [];
    for (let i = 0; i < 24; i++) {
      const a = buckets[Math.max(0, i - 1)] ?? 0;
      const b = buckets[i];
      const c = buckets[Math.min(23, i + 1)] ?? 0;
      out.push((a + b + c) / 3);
    }
    return out;
  }, [events]);

  const W = 260;
  const H = 48;
  const max = Math.max(...points, 1);
  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i / 23) * W} ${H - (v / max) * (H - 6) - 3}`)
    .join(" ");
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`;

  return (
    <div className="border-t border-white/5 px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="hud-title">Ingest stream</span>
        <span className="font-mono text-[9px] text-[#5c6b78]">24H</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CYAN} stopOpacity="0.35" />
            <stop offset="100%" stopColor={CYAN} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#spark)" />
        <path d={path} fill="none" stroke={CYAN} strokeWidth="1.4" />
      </svg>
    </div>
  );
}

/* ---------------- right rail: KPI stack ---------------- */

export function MetricsStack({ metrics, leads }: { metrics: Metrics | null; leads: Lead[] }) {
  const m = metrics;
  const pipeline = money(m?.pipelineCents ?? 0);
  const replyRate = `${((m?.replyRate ?? 0) * 100).toFixed(1)}%`;
  const load = m?.loadPct ?? 0;

  // Vertical bar chart: pipeline value grouped by stage (video had two bar panels)
  const stageBars = useMemo(() => {
    const groups: Array<{ stage: Stage; color: string }> = [
      { stage: "pending_outreach", color: "#5c6b78" },
      { stage: "outreach_sent", color: CYAN },
      { stage: "replied", color: "#00c3ff" },
      { stage: "qualified", color: MAGENTA },
      { stage: "won", color: "#00ffa3" },
      { stage: "no_show", color: AMBER },
    ];
    return groups.map((g) => {
      const count = leads.filter((l) => l.stage === g.stage).length;
      return { ...g, count, label: STAGE_LABEL[g.stage] };
    });
  }, [leads]);
  const maxBar = Math.max(...stageBars.map((b) => b.count), 1);

  // Reply-rate bar history visualizes the live replyRate (decorative wave only).
  const wave = useMemo(() => {
    if (m == null) return Array.from({ length: 22 }, () => 8);
    const base = m.replyRate * 100;
    return Array.from({ length: 22 }, (_, i) => {
      const wob = Math.sin(i * 1.7) * 12 + Math.cos(i * 0.9) * 8;
      return Math.max(6, Math.min(96, base * 1.6 + wob));
    });
  }, [m?.replyRate, m]);

  return (
    <div className="flex h-full flex-col overflow-y-auto feed">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="hud-title">Metrics console</span>
        <span className="chip chip-cyan" title="Derived from Supabase leads + settings">LIVE · SUPABASE</span>
      </div>

      {/* Pipeline value */}
      <div className="px-3 py-3 border-b border-white/5">
        <div className="hud-title mb-1">Pipeline value · live leads</div>
        <div className="font-mono text-2xl font-semibold tracking-tight text-[#e8f6f7] glow-cyan">
          {m ? pipeline : "—"}
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-[#5c6b78]">
          <span className="text-[#00f2fe]">{m?.activeNodes ?? 0} ACTIVE NODES</span>
          <span>·</span>
          <span>{m?.won ?? 0} WON</span>
          <span>·</span>
          <span className="text-[#ff9f43]">{m?.noShows ?? 0} NO-SHOW</span>
        </div>
      </div>

      {/* Load dial — derived HUD, not host CPU */}
      <div className="flex items-center justify-between gap-3 border-b border-white/5 px-3 py-3">
        <div>
          <div className="hud-title mb-1">Node load dial</div>
          <div className="font-mono text-3xl font-semibold text-[#e8f6f7]">{m ? `${load}%` : "—"}</div>
          <div className="mt-0.5 font-mono text-[9px] text-[#5c6b78]">
            DERIVED FROM LIVE NODE COUNT · NOT HOST CPU
          </div>
        </div>
        <RadialDial pct={m ? load : 0} />
      </div>

      {/* Stage bars */}
      <div className="border-b border-white/5 px-3 py-3">
        <div className="hud-title mb-2">Pipeline by stage · live leads</div>
        <div className="space-y-1.5">
          {stageBars.map((b) => (
            <div key={b.stage} className="flex items-center gap-2">
              <span className="w-24 truncate font-mono text-[9px] uppercase tracking-wider text-[#7d8b97]">{b.label}</span>
              <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-white/[0.04]">
                <div
                  className="h-full rounded-sm transition-all duration-700"
                  style={{ width: `${(b.count / maxBar) * 100}%`, background: b.color, boxShadow: `0 0 8px ${b.color}` }}
                />
              </div>
              <span className="w-5 text-right font-mono text-[10px] text-[#c8d4de]">{b.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Reply-rate wave */}
      <div className="border-b border-white/5 px-3 py-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="hud-title">Reply rate · live stages</span>
          <span className="font-mono text-[10px] text-[#00f2fe]">{m ? replyRate : "—"}</span>
        </div>
        <div className="flex h-14 items-end gap-[3px]">
          {wave.map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-sm transition-all duration-500"
              style={{
                height: `${h}%`,
                background: i % 4 === 3 ? MAGENTA : CYAN,
                opacity: 0.35 + (h / 100) * 0.65,
                boxShadow: `0 0 6px ${i % 4 === 3 ? MAGENTA : CYAN}33`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Automation chips */}
      <div className="px-3 py-3">
        <div className="hud-title mb-2">Automations</div>
        <div className="space-y-1.5 font-mono text-[10px]">
          <div className="flex items-center justify-between">
            <span className="text-[#8b98a5]">Lead Hunter</span>
            <span className="chip chip-amber" title="Fabricated Math.random intake disabled — use scrape_listing jobs">DISABLED</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#8b98a5]">Outbound engine</span>
            <span className={`chip ${m?.outreachRunning ? "chip-cyan" : "chip-amber"}`}>{m?.outreachRunning ? "RUNNING" : "PAUSED"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#8b98a5]">Pending replies</span>
            <span className="chip chip-magenta">{m?.pendingReplies ?? 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#8b98a5]">Pending outreach</span>
            <span className="chip chip-cyan">{m?.pendingOutreach ?? 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#8b98a5]">Pending sends</span>
            <span className="chip chip-cyan">{m?.pendingSends ?? 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RadialDial({ pct }: { pct: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const off = c - (Math.min(pct, 100) / 100) * c;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
      <circle
        cx="32" cy="32" r={r} fill="none"
        stroke={CYAN} strokeWidth="5" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        style={{ filter: `drop-shadow(0 0 4px ${CYAN})`, transition: "stroke-dashoffset 800ms ease" }}
      />
      <text x="32" y="36" textAnchor="middle" transform="rotate(90 32 32)" fill="#e8f6f7" fontSize="11" fontFamily="IBM Plex Mono, monospace">
        {pct}
      </text>
    </svg>
  );
}

/* ---------------- node inspector card (active lead) ---------------- */

export function NodeInspector({
  lead,
  onNudge,
  onProposal,
  onNoShow,
  onStage,
  proposing,
}: {
  lead: Lead | null;
  onNudge: () => void;
  onProposal: () => void;
  onNoShow: () => void;
  onStage: (s: Stage) => void;
  proposing: boolean;
}) {
  if (!lead) return null;
  const stageColor =
    lead.stage === "no_show" ? "chip-amber" : lead.stage === "won" ? "chip-cyan" : lead.stage === "qualified" ? "chip-magenta" : "chip-cyan";
  return (
    <div className="glass hud-frame pointer-events-auto absolute left-3 top-3 z-20 w-[min(15rem,calc(100%-1.5rem))] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[#e8f6f7]">{lead.company}</div>
          <div className="truncate font-mono text-[10px] text-[#7d8b97]">{lead.name} · {lead.handle}</div>
        </div>
        <span className={`chip ${stageColor}`}>{STAGE_LABEL[lead.stage]}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] text-[#8b98a5]">
        <div>SCORE <span className="text-[#00f2fe]">{lead.score}</span></div>
        <div>VALUE <span className="text-[#00ffa3]">{money(lead.value)}</span></div>
        <div className="col-span-2 truncate">CHANNEL {lead.channel.toUpperCase()}</div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <button onClick={onNudge} className="chip chip-cyan hover:bg-[#00f2fe]/15 transition-colors">NUDGE</button>
        <button onClick={onProposal} disabled={proposing} className="chip chip-magenta hover:bg-[#ff007f]/15 transition-colors disabled:opacity-50">
          {proposing ? "STAGING" : "PROPOSAL"}
        </button>
        <button onClick={onNoShow} className="chip chip-amber hover:bg-[#ff9f43]/15 transition-colors">NO-SHOW</button>
        {lead.stage !== "won" && lead.stage !== "lost" ? (
          <button onClick={() => onStage("won")} className="chip chip-cyan hover:bg-[#00f2fe]/15 transition-colors">CLOSE WON</button>
        ) : null}
      </div>
    </div>
  );
}

// Header chrome (JARVIS title, LIVE · SUPABASE badge, command palette) and
// the bottom strip (send throttle from Supabase settings — not fake CPU meters).
"use client";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Metrics } from "../lib/types";

export function Header({ onCommand, uptime }: { onCommand: () => void; uptime: string }) {
  return (
    <header className="glass hud-frame relative z-30 mx-2 mt-2 flex h-11 items-center justify-between px-4">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] tracking-[0.2em] text-[#00f2fe]">INBOUND CORTEX</span>
        <span className="chip chip-cyan hidden sm:inline" title="Authoritative live pipeline — Supabase + EventSource">
          LIVE · SUPABASE
        </span>
        <span className="hidden font-mono text-[9px] text-[#5c6b78] md:inline">LEAD INTAKE / SALES OPS</span>
      </div>
      <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center">
        <span className="sweep-text text-lg font-bold tracking-[0.34em] leading-5">JARVIS</span>
        <span className="font-mono text-[8px] tracking-[0.2em] text-[#5c6b78]">LIVE PIPELINE · NOT DEMO</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden font-mono text-[9px] text-[#5c6b78] md:inline">{uptime}</span>
        <Link to="/calendar" className="rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9.5px] text-[#8b98a5] transition-colors hover:border-[#00f2fe]/40 hover:text-[#00f2fe]">
          CAL
        </Link>
        <button
          onClick={onCommand}
          className="rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9.5px] text-[#8b98a5] transition-colors hover:border-[#00f2fe]/40 hover:text-[#00f2fe]"
        >
          ⌘K
        </button>
        <button
          onClick={() => {
            document.cookie = "jarvis_cortex_session=; Max-Age=0; Path=/";
            window.location.href = "/login";
          }}
          className="rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9.5px] text-[#8b98a5] transition-colors hover:border-[#ff007f]/40 hover:text-[#ff007f]"
          title="Sign out"
        >
          ⏻
        </button>
      </div>
    </header>
  );
}

export function DiagnosticsStrip({ metrics }: { metrics: Metrics | null }) {
  const throttle = metrics?.throttlePct ?? null;
  return (
    <div className="glass hud-frame relative z-30 mx-2 mb-2 mt-1 flex h-12 items-center gap-5 overflow-x-auto px-4">
      <div className="flex items-center gap-2">
        <span className="chip chip-cyan">LIVE · SUPABASE</span>
        <span className="hud-title">Pipeline strip</span>
      </div>
      <div className="hidden min-w-[12rem] flex-1 items-center gap-2 sm:flex">
        <span className="hud-title" title="settings.throttle_pct from Supabase">Send throttle (settings)</span>
        {throttle != null ? (
          <Meter label="SEND" pct={throttle} color="#00f2fe" className="flex-1" />
        ) : (
          <span className="font-mono text-[9px] text-[#ff9f43]">— awaiting Supabase metrics</span>
        )}
      </div>
      <div className="hidden items-center gap-2 lg:flex">
        <span className="font-mono text-[8px] tracking-wider text-[#5c6b78]">
          HUD dials removed — not host CPU/IO (those were decorative)
        </span>
      </div>
      <span className="chip chip-cyan hidden sm:inline">EDGE SSE</span>
    </div>
  );
}

function Meter({ label, pct, color, className = "" }: { label: string; pct: number; color: string; className?: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className="font-mono text-[8px] tracking-wider text-[#5c6b78]">{label}</span>
      <div className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
      <span className="font-mono text-[8px] text-[#7d8b97] w-6">{Math.round(pct)}</span>
    </div>
  );
}

export function CommandPalette({
  open,
  onClose,
  onSweep: _onSweep,
  onToggle,
  metrics,
}: {
  open: boolean;
  onClose: () => void;
  /** Kept for callers; Lead Hunter is hard-blocked and must not invent leads. */
  onSweep: () => void;
  onToggle: (which: "hunter" | "outreach", on: boolean) => void;
  metrics: Metrics | null;
}) {
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const cmds = [
    {
      id: "sweep",
      label: "Lead Hunter (disabled)",
      hint: "queues nothing — use scrape_listing browser_jobs",
      run: () => {
        // Do not call onSweep / runHunter — those paths fabricated leads.
        console.warn(
          "[cortex] Lead Hunter blocked — queue scrape_listing / scrape_search via luxe_supabase_REAL_PIPELINE",
        );
      },
    },
    {
      id: "hunter-on",
      label: "Lead Hunter toggle (UI only)",
      hint: "does not invent leads; real intake is scrape_* jobs",
      run: () => onToggle("hunter", !metrics?.hunterRunning),
    },
    { id: "outreach-on", label: metrics?.outreachRunning ? "Pause outbound engine" : "Resume outbound engine", hint: "automation toggle", run: () => onToggle("outreach", !metrics?.outreachRunning) },
  ].filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" onClick={onClose}>
      <div className="glass hud-frame w-[440px] max-w-[90vw] p-2" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a command…"
          className="w-full border-b border-white/5 bg-transparent px-3 py-2.5 text-[13px] text-[#e8eef4] placeholder-[#5c6b78] outline-none"
        />
        <div className="py-1">
          {cmds.map((c) => (
            <button
              key={c.id}
              onClick={() => { c.run(); onClose(); }}
              className="flex w-full items-center justify-between rounded px-3 py-2 text-left hover:bg-white/[0.04]"
            >
              <span className="text-[12px] text-[#d5dde4]">{c.label}</span>
              <span className="font-mono text-[9px] text-[#5c6b78]">{c.hint}</span>
            </button>
          ))}
          {cmds.length === 0 ? <div className="px-3 py-3 font-mono text-[10px] text-[#5c6b78]">No commands match.</div> : null}
        </div>
      </div>
    </div>
  );
}

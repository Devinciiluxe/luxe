// Compact lead roster under the map: one row per node, sorted by stage/score.
"use client";
import type { Lead, Stage } from "../lib/types";
import { STAGE_LABEL } from "../lib/types";
import { money } from "../lib/utils";

const STAGE_DOT: Record<Stage, string> = {
  pending_outreach: "#5c6b78",
  outreach_sent: "#00f2fe",
  replied: "#00c3ff",
  qualified: "#ff007f",
  won: "#00ffa3",
  lost: "#3a4652",
  no_show: "#ff9f43",
};

export function LeadRoster({
  leads,
  activeId,
  glowId,
  onPick,
}: {
  leads: Lead[];
  activeId: string | null;
  glowId: string | null;
  onPick: (id: string) => void;
}) {
  const sorted = [...leads].sort((a, b) => {
    const order: Record<Stage, number> = { qualified: 0, replied: 1, outreach_sent: 2, pending_outreach: 3, won: 4, no_show: 5, lost: 6 };
    return order[a.stage] - order[b.stage] || b.score - a.score;
  });
  return (
    <div className="glass hud-frame mx-2 mb-2 max-h-44 overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="hud-title">Lead roster</span>
        <span className="font-mono text-[9px] text-[#5c6b78]">{leads.length} NODES ON MAP</span>
      </div>
      <div className="feed max-h-[140px] overflow-y-auto">
        {sorted.map((l) => {
          const active = l.id === activeId;
          const glowing = l.id === glowId;
          return (
            <button
              key={l.id}
              onClick={() => onPick(l.id)}
              className={`flex w-full items-center gap-2.5 border-b border-white/[0.03] px-3 py-1.5 text-left transition-colors ${
                active ? "bg-[#ff007f]/[0.07]" : "hover:bg-white/[0.03]"
              }`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: active ? "#ff007f" : STAGE_DOT[l.stage],
                  boxShadow: glowing
                    ? "0 0 10px #ff007f, 0 0 18px #ff007f"
                    : active
                      ? "0 0 8px #ff007f"
                      : `0 0 6px ${STAGE_DOT[l.stage]}66`,
                }}
              />
              <span className="w-40 truncate text-[11.5px] font-medium text-[#c8d4de]">{l.company}</span>
              <span className="hidden w-28 truncate font-mono text-[9.5px] text-[#5c6b78] md:inline">{l.name}</span>
              <span className="hidden font-mono text-[9px] uppercase tracking-wider text-[#7d8b97] sm:inline">{STAGE_LABEL[l.stage]}</span>
              <span className="ml-auto font-mono text-[10px] text-[#00f2fe]">{l.score}</span>
              <span className="w-16 text-right font-mono text-[10px] text-[#00ffa3]">{money(l.value)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

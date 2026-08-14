// The cortex as pure SVG — zero WebGL/canvas — so it renders in SSR snapshots,
// sandboxed preview panes, and every browser. Matches the reference look:
// dense glowing blue network with orange/pink clusters, floating holo screens,
// plasma envelope, scan ring, metallic floor. Fully interactive: click a node
// to open its chat, a light stream follows the neuropathways to it, bursts,
// then the node pulses softly until the thread is closed. Also animates when
// Jarvis works on a node (streamEvent).
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Lead, Metrics } from "../lib/types";
import { CORTEX_ANCHORS } from "../lib/cortex-anchors";
import { AMBER, CYAN, MAGENTA } from "../lib/utils";

const PURPLE = "#9F7BFF";
const PINK = "#FF6FB5";
const GOLD = "#FFD76A";

function sq(a: number[], b: number[]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function holoStats(kind: string, m: Metrics | null): { title: string; label: string; color: string; bars: number[] } {
  const wave = (seed: number, i: number) => 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(seed + i * 1.9 + Math.sin(i * 0.7) * 2));
  const mk = (v: number, seed: number) => Array.from({ length: 8 }, (_, i) => Math.min(1, v * 1.15 * wave(seed, i)));
  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
  switch (kind) {
    case "ACTIVE NODES":
      return { title: kind, label: String(m?.activeNodes ?? 0), color: CYAN, bars: mk((m?.activeNodes ?? 0) / 24, 3.1) };
    case "PIPELINE":
      return { title: kind, label: m ? money(m.pipelineCents) : "$0", color: PURPLE, bars: mk((m?.pipelineCents ?? 0) / 1_200_000, 5.7) };
    case "REPLY RATE":
      return { title: kind, label: m ? Math.round((m.replyRate ?? 0) * 100) + "%" : "—", color: CYAN, bars: mk(m?.replyRate ?? 0, 8.2) };
    case "PENDING":
      return { title: kind, label: String(m?.pendingReplies ?? 0), color: "#FF9F43", bars: mk((m?.pendingReplies ?? 0) / 12, 4.4) };
    default:
      return { title: kind, label: String(m?.won ?? 0), color: "#5EEAD4", bars: mk((m?.won ?? 0) / 10, 2.2) };
  }
}

interface StreamState {
  pts: { x: number; y: number }[];
  lens: number[];
  total: number;
  t: number;
  trail: { x: number; y: number }[];
  target: { x: number; y: number };
}
interface BurstState {
  x: number;
  y: number;
  t: number;
}

export function BrainStatic({
  leads,
  activeLeadId,
  workActive,
  metrics,
  streamEvent,
  onPick,
}: {
  leads: Lead[];
  activeLeadId: string | null;
  workActive: boolean;
  metrics: Metrics | null;
  streamEvent: { leadId: string; key: number } | null;
  onPick?: (leadId: string) => void;
}) {
  const anchors = useMemo(() => CORTEX_ANCHORS.map((a) => [a[0], a[1], a[2]] as number[]), []);
  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: [number, number][] = [];
    for (let i = 0; i < anchors.length; i++) {
      const nbs = anchors
        .map((a, j) => ({ j, d: sq(a, anchors[i]) }))
        .filter((x) => x.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { j } of nbs) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([i, j]);
      }
    }
    return out;
  }, [anchors]);
  const adj = useMemo(() => {
    const a = Array.from({ length: anchors.length }, () => [] as number[]);
    for (const [i, j] of edges) {
      a[i].push(j);
      a[j].push(i);
    }
    return a;
  }, [edges, anchors.length]);

  const proj = (v: number[]) => {
    const RY = 0.62, RX = -0.1;
    const x1 = v[0] * Math.cos(RY) + v[2] * Math.sin(RY);
    const z1 = -v[0] * Math.sin(RY) + v[2] * Math.cos(RY);
    const y2 = v[1] * Math.cos(RX) - z1 * Math.sin(RX);
    const z2 = v[1] * Math.sin(RX) + z1 * Math.cos(RX);
    const f = 3.2, s = f / (f + z2 + 0.6);
    return { x: 240 + x1 * s * 175, y: 235 - y2 * s * 175 };
  };

  const leadPts = useMemo(
    () =>
      leads.map((l) => {
        const target = [l.n[0] * 2, l.n[1] * 1.6, l.n[2] * 1.9];
        let best = anchors[0], bd = Infinity;
        for (const a of anchors) {
          const d = sq(a, target);
          if (d < bd) {
            bd = d;
            best = a;
          }
        }
        const p = proj(best);
        p.x += ((l.id.charCodeAt(0) % 5) - 2) * 3;
        return { l, x: p.x, y: p.y };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leads],
  );

  let sys = anchors[0], bestS = -Infinity;
  for (const a of anchors) {
    const s = a[2] - Math.abs(a[1]) * 0.25;
    if (s > bestS) {
      bestS = s;
      sys = a;
    }
  }
  const sysP = proj([sys[0] * 1.12, sys[1] * 1.12, sys[2] * 1.12]);

  // ------- animation state (rAF loop, no-op when idle) -------
  const animRef = useRef<{ stream: StreamState | null; burst: BurstState | null; last: number }>({ stream: null, burst: null, last: 0 });
  const [, setTick] = useState(0);
  const [hoverLead, setHoverLead] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const a = animRef.current;
      const now = performance.now();
      const dt = Math.min(0.05, (now - a.last) / 1000);
      a.last = now;
      let dirty = false;
      if (a.stream) {
        const s = a.stream;
        s.t += dt / 0.95;
        const target = Math.min(1, s.t) * s.total;
        let lo = 0, hi = s.lens.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (s.lens[mid] < target) lo = mid + 1;
          else hi = mid;
        }
        const i = Math.max(0, lo - 1);
        const seg = s.lens[i + 1] - s.lens[i];
        const f = seg > 0 ? Math.min(1, Math.max(0, (target - s.lens[i]) / seg)) : 0;
        const hx = s.pts[i].x + (s.pts[i + 1].x - s.pts[i].x) * f;
        const hy = s.pts[i].y + (s.pts[i + 1].y - s.pts[i].y) * f;
        s.trail.push({ x: hx, y: hy });
        if (s.trail.length > 14) s.trail.shift();
        if (s.t >= 1) {
          a.burst = { x: hx, y: hy, t: 0 };
          a.stream = null;
        }
        dirty = true;
      }
      if (a.burst) {
        a.burst.t += dt / 0.9;
        if (a.burst.t >= 1) a.burst = null;
        dirty = true;
      }
      if (dirty) setTick((n) => n + 1);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // stream triggered by Jarvis acting on a node
  useEffect(() => {
    if (!streamEvent?.leadId) return;
    const lead = leads.find((l) => l.id === streamEvent.leadId);
    if (lead) startStream(lead);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEvent]);

  const startStream = (lead: Lead) => {
    const target = [lead.n[0] * 2, lead.n[1] * 1.6, lead.n[2] * 1.9];
    let tgt = 0, bd = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const d = sq(anchors[i], target);
      if (d < bd) {
        bd = d;
        tgt = i;
      }
    }
    let org = 0, bg = -Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const d = sq(anchors[i], anchors[tgt]);
      if (d > bg) {
        bg = d;
        org = i;
      }
    }
    const idxPath = bfs(adj, org, tgt) || [tgt];
    const worldPts = idxPath.map((i) => anchors[i]);
    const pts = [...worldPts.map((w) => proj(w)), proj(target)];
    const lens = [0];
    for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    animRef.current.stream = { pts, lens, total: lens[lens.length - 1], t: 0, trail: [], target: pts[pts.length - 1] };
    setTick((n) => n + 1);
  };

  const onSvgClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !onPick) return;
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * 480;
    const sy = ((e.clientY - rect.top) / rect.height) * 480;
    let best: string | null = null, bestD = 18 * 18;
    for (const { l, x, y } of leadPts) {
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = l.id;
      }
    }
    if (best) onPick(best);
  };

  const onSvgMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * 480;
    const sy = ((e.clientY - rect.top) / rect.height) * 480;
    let hover: string | null = null;
    for (const { l, x, y } of leadPts) {
      if ((x - sx) ** 2 + (y - sy) ** 2 < 14 * 14) {
        hover = l.id;
        break;
      }
    }
    setHoverLead((h) => (h === hover ? h : hover));
  };

  const stream = animRef.current.stream;
  const burst = animRef.current.burst;
  const activePt = activeLeadId ? leadPts.find((p) => p.l.id === activeLeadId) : null;
  const panels = ["ACTIVE NODES", "PIPELINE", "REPLY RATE"].map((k) => ({ k, ...holoStats(k, metrics) }));

  return (
    <div className="brain-host flex items-center justify-center">
      <svg
        ref={svgRef}
        viewBox="0 0 480 480"
        onClick={onSvgClick}
        onMouseMove={onSvgMove}
        className="h-full max-h-[560px] w-auto"
        style={{ cursor: hoverLead ? "pointer" : "default", filter: "drop-shadow(0 0 20px rgba(0,242,254,0.35))" }}
        aria-label="Neural cortex"
      >
        <defs>
          <radialGradient id="plasmaS" cx="50%" cy="46%" r="52%">
            <stop offset="0%" stopColor="rgba(0,242,254,0.18)" />
            <stop offset="45%" stopColor="rgba(42,75,255,0.10)" />
            <stop offset="100%" stopColor="rgba(0,10,18,0)" />
          </radialGradient>
          <radialGradient id="wallGlowS" cx="50%" cy="0%" r="80%">
            <stop offset="0%" stopColor="rgba(0,242,254,0.10)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
          <filter id="softGlowS" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* room */}
        <rect x="0" y="0" width="480" height="480" fill="url(#wallGlowS)" />
        <rect x="0" y="408" width="480" height="72" fill="rgba(7,12,20,0.95)" />
        {Array.from({ length: 25 }, (_, i) => (
          <line key={i} x1={i * 20} y1="408" x2={i * 20} y2="480" stroke="rgba(0,242,254,0.07)" strokeWidth="1" />
        ))}
        {Array.from({ length: 4 }, (_, i) => (
          <line key={`h${i}`} x1="0" y1={408 + (i + 1) * 18} x2="480" y2={408 + (i + 1) * 18} stroke="rgba(0,242,254,0.06)" strokeWidth="1" />
        ))}
        <line x1="0" y1="408" x2="480" y2="408" stroke="rgba(0,242,254,0.4)" strokeWidth="1.6" />

        {/* plasma envelope */}
        <circle cx="240" cy="235" r="225" fill="url(#plasmaS)" />
        {/* hologram scan rings */}
        <ellipse cx="240" cy="235" rx="215" ry="78" fill="none" stroke="rgba(0,242,254,0.16)" strokeWidth="1.2">
          <animateTransform attributeName="transform" type="rotate" from="0 240 235" to="360 240 235" dur="11s" repeatCount="indefinite" />
        </ellipse>
        <ellipse cx="240" cy="235" rx="160" ry="58" fill="none" stroke="rgba(159,123,255,0.14)" strokeWidth="1">
          <animateTransform attributeName="transform" type="rotate" from="360 240 235" to="0 240 235" dur="17s" repeatCount="indefinite" />
        </ellipse>

        {/* holo data screens (behind the brain, like the reference) */}
        {panels.map((pn, i) => {
          const x = i === 0 ? 18 : i === 1 ? 480 - 168 : 18;
          const y = i === 0 ? 18 : i === 1 ? 18 : 480 - 92;
          return (
            <g key={pn.k}>
              <rect x={x} y={y} width="150" height="74" rx="8" fill="rgba(5,14,22,0.55)" stroke="rgba(0,242,254,0.4)" strokeWidth="1" />
              <path d={`M${x + 8} ${y + 2} v10 M${x + 2} ${y + 8} h10`} stroke="rgba(0,242,254,0.9)" strokeWidth="2" fill="none" />
              <path d={`M${x + 142} ${y + 72} v-10 M${x + 148} ${y + 66} h-10`} stroke="rgba(0,242,254,0.9)" strokeWidth="2" fill="none" />
              <text x={x + 12} y={y + 17} fontSize="9" fontWeight="700" fontFamily="'SF Mono', ui-monospace, monospace" fill="rgba(159,123,255,0.95)">{pn.k}</text>
              <text x={x + 12} y={y + 38} fontSize="19" fontWeight="600" fontFamily="'SF Mono', ui-monospace, monospace" fill={pn.color}>{pn.label}</text>
              {pn.bars.slice(0, 6).map((b, bi) => (
                <rect key={bi} x={x + 12 + bi * 22} y={y + 62 - Math.max(4, b * 26)} width="17" height={Math.max(4, b * 26)} rx="1.5" fill={pn.color} opacity={0.25 + 0.6 * b} />
              ))}
            </g>
          );
        })}

        {/* network skin */}
        {edges.map(([i, j], k) => {
          const a = proj(anchors[i]), b = proj(anchors[j]);
          const warm = (i + j) % 31 === 0;
          return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={warm ? "rgba(255,159,67,0.28)" : "rgba(0,242,254,0.22)"} strokeWidth={warm ? 1.1 : 0.8} />;
        })}
        {/* cortex dots + orange/pink clusters */}
        {anchors.map((a, i) => {
          const p = proj(a);
          const warm = i % 17 === 0;
          return <circle key={i} cx={p.x} cy={p.y} r={warm ? 2.8 : 1.9} fill={i % 17 === 0 ? PINK : i % 9 === 0 ? AMBER : "rgba(0,242,254,0.85)"} />;
        })}

        {/* leads — click opens the chat */}
        {leadPts.map(({ l, x, y }) => (
          <g key={l.id}>
            {l.id === activeLeadId ? (
              <circle cx={x} cy={y} r="5" fill="none" stroke={MAGENTA} strokeWidth="1.4" filter="url(#softGlowS)">
                <animate attributeName="r" values="6;24" dur="1.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.9;0" dur="1.4s" repeatCount="indefinite" />
              </circle>
            ) : null}
            <circle
              cx={x}
              cy={y}
              r={l.id === activeLeadId ? 7 : hoverLead === l.id ? 6 : 4.5}
              fill={l.id === activeLeadId ? MAGENTA : l.stage === "no_show" ? AMBER : CYAN}
              filter={l.id === activeLeadId || hoverLead === l.id ? "url(#softGlowS)" : undefined}
            />
          </g>
        ))}

        {/* light stream through the neuropathways */}
        {stream && (
          <g>
            {stream.trail.length > 1 ? (
              <polyline
                points={stream.trail.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="rgba(255,183,120,0.75)"
                strokeWidth="2"
                strokeLinecap="round"
                filter="url(#softGlowS)"
              />
            ) : null}
            <circle cx={stream.trail[stream.trail.length - 1]?.x ?? stream.pts[0].x} cy={stream.trail[stream.trail.length - 1]?.y ?? stream.pts[0].y} r="5" fill={GOLD} filter="url(#softGlowS)" />
          </g>
        )}
        {/* burst on arrival */}
        {burst && (
          <g>
            {[0, 1].map((r) => (
              <circle key={r} cx={burst.x} cy={burst.y} r={4 + burst.t * 46} fill="none" stroke={r === 0 ? MAGENTA : GOLD} strokeWidth="1.6" opacity={1 - burst.t} />
            ))}
            {Array.from({ length: 26 }, (_, i) => {
              const ang = (i / 26) * Math.PI * 2 + burst.t * 1.3;
              const dist = burst.t * 66 + Math.sin(burst.t * 9 + i) * 6;
              return (
                <circle key={i} cx={burst.x + Math.cos(ang) * dist} cy={burst.y + Math.sin(ang) * dist} r={1.4 + (1 - burst.t) * 2} fill={i % 3 === 0 ? GOLD : PINK} opacity={1 - burst.t} />
              );
            })}
          </g>
        )}

        {/* working_jobs node */}
        {workActive ? (
          <circle cx={sysP.x} cy={sysP.y} r="10" fill="none" stroke={MAGENTA} strokeWidth="1.8" filter="url(#softGlowS)">
            <animate attributeName="r" values="10;34" dur="1.1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0" dur="1.1s" repeatCount="indefinite" />
          </circle>
        ) : null}
        <circle cx={sysP.x} cy={sysP.y} r={workActive ? 10 : 8} fill={workActive ? MAGENTA : PURPLE} filter="url(#softGlowS)" />
        <text x={sysP.x} y={sysP.y - 17} textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="'SF Mono', ui-monospace, monospace" fill={workActive ? MAGENTA : PURPLE}>
          WORKING_JOBS
        </text>
        {/* node legend hint */}
        <text x="240" y="476" textAnchor="middle" fontSize="9" fontFamily="'SF Mono', ui-monospace, monospace" fill="rgba(123,162,186,0.8)">
          CLICK A NODE TO OPEN ITS THREAD
        </text>
      </svg>
    </div>
  );
}

function bfs(adj: number[][], from: number, to: number): number[] | null {
  if (from === to) return [from];
  const prev = new Array<number>(adj.length).fill(-1);
  const q: number[] = [from];
  prev[from] = from;
  let found = false;
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) {
      found = true;
      break;
    }
    for (const nb of adj[cur]) {
      if (prev[nb] === -1) {
        prev[nb] = cur;
        q.push(nb);
      }
    }
  }
  if (!found) return null;
  const path = [to];
  let c = to;
  while (c !== from) {
    c = prev[c];
    path.push(c);
  }
  return path.reverse();
}
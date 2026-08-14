import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
// sonner removed — toasts disabled per design
import { getSnapshot } from "../lib/cortex";
import type { Snapshot } from "../lib/types";
import { useCortex } from "../lib/store";
import { Header, DiagnosticsStrip, CommandPalette } from "../components/chrome";
import { HunterLog, Sparkline, MetricsStack, NodeInspector } from "../components/panels";
import { LeadRoster } from "../components/lead-list";
import { ChatWindow } from "../components/chat";
import { BrainStatic } from "../components/brain-static";
import { useVoice, parseCommand } from "../hooks/use-voice";

// Native-shell bridge — called from Jarvis-cortex's PyQt6 window (ui.py's
// MindMapView, via page().runJavaScript) when this dashboard is embedded as
// JARVIS's actual UI instead of viewed as a standalone page. Visual only:
// never routes through useVoice's speak(), which would double up on audio —
// the real voice is already playing from the native app's own LLM session
// through the system speakers.
declare global {
  interface Window {
    __jarvisBridge?: { setState: (state: string) => void; say: (text: string) => void };
  }
}

const BrainScene = lazy(() => import("../components/brain-scene"));

export const Route = createFileRoute("/cortex")({
  loader: async (): Promise<Snapshot> => {
    try {
      return await getSnapshot();
    } catch {
      return { leads: [], events: [], metrics: null as unknown as Snapshot["metrics"], activeLeadId: null };
    }
  },
  component: Dashboard,
});

function Dashboard() {
  const initial = Route.useLoaderData();
  const c = useCortex();
  const leads = c.leads.length ? c.leads : initial.leads ?? [];
  const events = c.events.length ? c.events : (initial.events ?? []);
  const metrics = c.metrics ?? initial.metrics ?? null;
  const [cmdOpen, setCmdOpen] = useState(false);
  const [uptime, setUptime] = useState("00:00:00");

  // ---- Jarvis voice assistant ----
  const voice = useVoice();
  const [voiceOn, setVoiceOn] = useState(true);
  const spokenRef = useRef<Set<string>>(new Set());
  const announcedRef = useRef<number>(0);

  const handleVoice = (text: string) => {
    if (!voiceOn) return;
    const action = parseCommand(text);
    if (action.kind === "open") {
      const q = (action.leadName ?? "").toLowerCase();
      const hit = leads.find((l) => l.company.toLowerCase().includes(q) || l.name.toLowerCase().includes(q));
      if (hit) {
        c.selectLead(hit.id);
        voice.speak(`Opening ${hit.company}.`);
      } else {
        voice.speak(`I couldn't find a node for ${action.leadName}.`);
      }
      return;
    }
    switch (action.kind) {
      case "sweep":
        void c.sweep();
        voice.speak("Running the Lead Hunter now. New nodes will light up the cortex.");
        return;
      case "propose":
        if (c.activeLeadId) {
          void c.proposal();
          voice.speak("Staging the proposal for the active node.");
        }
        return;
      case "noshows":
        void c.noShow();
        voice.speak("Marking the active node as a no-show and queueing the rescue sequence.");
        return;
      case "pause":
        void c.toggle("hunter", false);
        voice.speak("Pausing the Lead Hunter.");
        return;
      case "resume":
        void c.toggle("hunter", true);
        voice.speak("Resuming the Lead Hunter.");
        return;
      case "report": {
        const target = c.activeLeadId ?? c.openIds[0] ?? c.leads[0]?.id;
        if (target) {
          if (!c.openIds.includes(target)) c.selectLead(target);
          void c.sendTo(target, "Give me the account report.").then((reply) => {
            if (reply) voice.speak("Here's the report: " + reply);
          });
        }
        return;
      }
      default: {
        const target = c.activeLeadId ?? c.openIds[0];
        if (target) {
          void c.sendTo(target, text).then((reply) => {
            if (reply) voice.speak(stripSlots(reply));
          });
        } else if (c.leads[0]) {
          c.selectLead(c.leads[0].id);
          voice.speak("Opening your first thread.");
        } else {
          voice.speak("No nodes on the cortex yet. Try running the Lead Hunter.");
        }
      }
    }
  };
  voice.setOnFinal(handleVoice);

  // Speak Jarvis replies out loud as they land in any open thread.
  useEffect(() => {
    if (!voiceOn) return;
    for (const id of c.openIds) {
      const t = c.threads[id];
      if (!t) continue;
      for (const m of t.messages) {
        if (m.role === "jarvis" && !m.pending && !spokenRef.current.has(m.id) && !m.id.startsWith("pending")) {
          if (spokenRef.current.size > 200) spokenRef.current.clear();
          spokenRef.current.add(m.id);
          voice.speak(stripSlots(m.body));
        }
      }
    }
  }, [c.threads, c.openIds, voiceOn, voice]);

  // Announce node events (new scrape / activation) by voice.
  useEffect(() => {
    if (!voiceOn || events.length === 0) return;
    const newest = events[0];
    if (newest.id === announcedRef.current) return;
    announcedRef.current = newest.id;
    if (newest.kind === "scrape") voice.speak("Lead Hunter surfaced a new node. Score " + (newest.datum ?? "") + ".");
    else if (newest.kind === "reply") voice.speak("Automation reply sent on the active thread.");
  }, [events, voiceOn, voice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    window.__jarvisBridge = {
      // Drives the same `thinking` flag chat sends use — the WORKING_JOBS
      // node flares and the wave-sweep ripples across the brain exactly like
      // it does for an in-app reply, but for the native app's real voice.
      setState: (state) => {
        c.setNativeSpeaking(state === "SPEAKING");
      },
      say: (text) => {
        void text; // captions disabled
      },
    };
    return () => {
      delete window.__jarvisBridge;
    };
  }, [c.setNativeSpeaking]);

  useEffect(() => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const hh = String(Math.floor(s / 3600)).padStart(2, "0");
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      setUptime(`${hh}:${mm}:${ss}`);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Start at the SSR fallback (700) on every render, including the first
  // client render, so hydration always matches the server markup. Only
  // switch to the real window height after mount (a client-only effect
  // can't run during SSR), via a state update — that's a normal post-mount
  // re-render, not a hydration mismatch.
  const [viewportH, setViewportH] = useState(700);
  const [viewportW, setViewportW] = useState(1200);
  useEffect(() => {
    const apply = () => {
      setViewportH(window.innerHeight);
      setViewportW(window.innerWidth);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  const cascade = (i: number) => {
    const narrow = viewportW < 640;
    const xStep = narrow ? 12 : 34;
    return {
      x: (narrow ? 8 : 20) + (i % (narrow ? 3 : 6)) * xStep,
      y: 14 + Math.min(i, 5) * (narrow ? 48 : 64) + (viewportH > 800 ? 40 : 0),
    };
  };

  return (
    <div className="flex h-dvh flex-col">
      <Header onCommand={() => setCmdOpen(true)} uptime={uptime} />

      <div className="mt-2 grid min-h-0 flex-1 grid-cols-1 gap-2 px-2 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className="glass hud-frame order-2 hidden min-h-0 flex-col lg:order-1 lg:flex h-full">
          <div className="min-h-0 flex-1 overflow-hidden"><HunterLog events={events} /></div>
          <Sparkline events={events} />
        </aside>

        <main className="glass hud-frame relative order-1 min-h-[280px] overflow-hidden lg:order-2 h-[42vh] sm:h-[52vh] lg:h-auto">
          <div className="pointer-events-none absolute left-3 top-3 z-10 select-none">
            <span className="hud-title">Neural cortex</span>
            <div className="font-mono text-[9px] text-[#5c6b78]">
              {metrics?.activeNodes ?? leads.length} active nodes · click node → floating thread · mic (right) → voice
            </div>
            <div className="mt-2 flex items-center gap-1.5 font-mono text-[8.5px] tracking-[0.14em]">
              <span className="chip chip-cyan">CORTEX v6</span>
              <span className={`chip ${c.thinking ? "chip-magenta pulse" : "chip-cyan"}`}>
                WORKING_JOBS {c.thinking ? "· ACTIVE" : "· IDLE"}
              </span>
              <span className="text-[#5c6b78]">— lights when Jarvis replies</span>
            </div>
            <div className="mt-1.5 font-mono text-[8.5px] tracking-[0.14em] text-[#5c6b78]">
              {c.openIds.length} thread{c.openIds.length === 1 ? "" : "s"} open
            </div>
          </div>

          <Suspense
            fallback={
              <BrainStatic
                leads={leads}
                activeLeadId={c.activeLeadId}
                workActive={c.thinking}
                metrics={metrics}
                streamEvent={c.stream}
                onPick={(id) => void c.selectLead(id)}
              />
            }
          >
            <BrainScene
              leads={leads}
              activeLeadId={c.activeLeadId}
              glowLeadId={c.glowLeadId}
              workActive={c.thinking}
              metrics={metrics}
              streamEvent={c.stream}
              onPick={(id) => void c.selectLead(id)}
            />
          </Suspense>

          <NodeInspector
            lead={c.activeLead}
            onNudge={() => c.activeLeadId && void c.queueNudge(c.activeLeadId)}
            onProposal={() => void c.proposal()}
            onNoShow={() => void c.noShow()}
            onStage={(s) => void c.moveStage(s)}
            proposing={c.proposing}
          />
        </main>

        <aside className="glass hud-frame order-3 hidden min-h-0 lg:flex h-full flex-col overflow-hidden">
          <MetricsStack metrics={metrics} leads={leads} />
        </aside>
      </div>

      {/* Floating conversation windows — open as many as you like, drag anywhere */}
      {c.openIds.map((id, i) => {
        const t = c.threads[id];
        return (
          <ChatWindow
            key={id}
            lead={t?.lead ?? null}
            messages={t?.messages ?? []}
            state={t?.chatState ?? "closed"}
            thinking={t?.thinking ?? false}
            active={id === c.activeLeadId}
            initialPos={cascade(i)}
            onSend={(txt) => void c.sendTo(id, txt)}
            onClose={() => c.closeChat(id)}
            onFocus={() => c.activateChat(id)}
          />
        );
      })}

      <LeadRoster
        leads={leads}
        activeId={c.activeLeadId}
        glowId={c.glowLeadId}
        onPick={(id) => void c.selectLead(id)}
      />
      <DiagnosticsStrip metrics={metrics} />

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onSweep={() => void c.sweep()}
        onToggle={(w, on) => void c.toggle(w, on)}
        metrics={metrics}
      />

      <VoiceHUD
        supported={voice.supported}
        listening={voice.listening}
        speaking={voice.speaking}
        interim={voice.interim}
        voiceOn={voiceOn}
        openCount={c.openIds.length}
        onToggleVoice={() => setVoiceOn((v) => !v)}
        onStart={() => (voice.listening ? voice.stop() : voice.start())}
      />

    </div>
  );
}

function stripSlots(body: string): string {
  const i = body.indexOf("__SLOTS__");
  return (i >= 0 ? body.slice(0, i) : body).replace(/[#_*]/g, " ").trim();
}

function VoiceHUD({
  supported,
  listening,
  speaking,
  interim,
  voiceOn,
  openCount,
  onToggleVoice,
  onStart,
}: {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  interim: string;
  voiceOn: boolean;
  openCount: number;
  onToggleVoice: () => void;
  onStart: () => void;
}) {
  if (!supported) {
    return (
      <div className="fixed right-3 top-16 z-50 font-mono text-[8.5px] tracking-[0.14em] text-[#5c6b78]">
        VOICE N/A — needs Chrome
      </div>
    );
  }
  return (
    <div className="fixed right-3 top-16 z-50 flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <span className="chip chip-cyan font-mono text-[8.5px] tracking-[0.14em]">{openCount} THREADS</span>
        <span className="chip chip-cyan font-mono text-[8.5px] tracking-[0.14em]" style={{ opacity: voiceOn ? 1 : 0.4 }} onClick={onToggleVoice}>
          VOICE {voiceOn ? "ON" : "OFF"}
        </span>
      </div>
      <button
        onClick={onStart}
        className={`relative flex h-11 w-11 items-center justify-center rounded-full border font-mono text-[9px] font-semibold transition-all ${
          listening
            ? "border-[#00f2fe] bg-[#00f2fe]/20 text-[#00f2fe] pulse"
            : speaking
              ? "border-[#ff007f] bg-[#ff007f]/15 text-[#ff007f]"
              : "border-white/20 bg-black/40 text-[#9fb3c4] hover:border-[#00f2fe]/60"
        }`}
        style={{ boxShadow: listening ? "0 0 18px #00f2fe66" : speaking ? "0 0 18px #ff007f66" : "none" }}
        title="Voice assistant"
        aria-label="Toggle Jarvis voice"
      >
        {listening ? <MicIcon /> : speaking ? <WaveIcon /> : <MicIcon />}
      </button>
      {interim ? (
        <div className="max-w-[220px] rounded-md border border-[#00f2fe]/30 bg-black/70 px-2 py-1 text-right font-mono text-[9px] text-[#8fe9f5]">
          “{interim}”
        </div>
      ) : null}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 18v3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 10h3l3-6 4 14 3-8h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
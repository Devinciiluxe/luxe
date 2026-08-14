// Client state for the dashboard. The initial snapshot comes from SSR; every
// mutation (chat send, node glow trigger, hunter sweep, stage move, pause) goes
// through a server function; cross-tab live frames arrive over SSE from /api/events.
//
// Multi-thread: many conversation windows can be open at once. Each open lead
// gets its own thread (messages/state/thinking). The brain keeps a single
// "focused" lead for glow/z-order, and emits `stream` events that drive the
// sparkle-light trail across the cortex toward the node being worked.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Lead, LiveFrame, LogEvent, Metrics, Msg, Snapshot } from "./types";
import { STAGE_LABEL } from "./types";
import {
  focusNode,
  getLeadThread,
  getSnapshot,
  makeProposal,
  markNoShow,
  runHunter,
  sendAutomationReply,
  sendChat,
  setLeadStageFn,
  toggleAutomation,
} from "./cortex";

export type ChatState = "closed" | "typing" | "sending" | "jarvis-reply";

export interface ChatMessage extends Msg {
  pending?: boolean;
}

export interface ChatThread {
  lead: Lead | null;
  messages: ChatMessage[];
  chatState: ChatState;
  thinking: boolean;
}

export interface StreamEvent {
  leadId: string;
  key: number;
}

export function useCortex() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  // True while the native voice shell (Jarvis-cortex's PyQt6 window, via
  // window.__jarvisBridge) is actually speaking out loud — ORed into
  // `thinking` below so the brain's WORKING_JOBS pulse/wave-sweep reacts to
  // real voice activity, not just in-app chat sends.
  const [nativeSpeaking, setNativeSpeaking] = useState(false);
  // ---- multi-thread conversations ----
  const [threads, setThreads] = useState<Record<string, ChatThread>>({});
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [glowLeadId, setGlowLeadId] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamEvent | null>(null);
  const [hunterSweeping, setHunterSweeping] = useState(false);
  const [proposing, setProposing] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const patchThread = useCallback((id: string, patch: Partial<ChatThread>) => {
    setThreads((p) => (p[id] ? { ...p, [id]: { ...p[id], ...patch } } : p));
  }, []);

  const triggerStream = useCallback((leadId: string) => {
    setStream((s) => ({ leadId, key: (s?.key ?? Date.now()) + 1 }));
  }, []);

  const applyFrame = useCallback(
    (frame: LiveFrame) => {
      if (frame.type === "event") {
        setEvents((e) => [frame.event, ...e].slice(0, 30));
      } else if (frame.type === "metrics") {
        setMetrics(frame.metrics);
      } else if (frame.type === "node") {
        setGlowLeadId(frame.leadId);
        triggerStream(frame.leadId);
        setSnap((s) =>
          s
            ? {
                ...s,
                leads: s.leads.map((l) =>
                  l.id === frame.leadId
                    ? {
                        ...l,
                        ...(frame.stage ? { stage: frame.stage as Lead["stage"] } : {}),
                        ...(frame.score != null ? { score: frame.score } : {}),
                      }
                    : l,
                ),
              }
            : s,
        );
      } else if (frame.type === "message") {
        setGlowLeadId(frame.lead.id);
        triggerStream(frame.lead.id);
        setThreads((p) =>
          p[frame.lead.id]
            ? {
                ...p,
                [frame.lead.id]: {
                  ...p[frame.lead.id],
                  messages: p[frame.lead.id].messages.some((m) => m.id === frame.msg.id)
                    ? p[frame.lead.id].messages
                    : [...p[frame.lead.id].messages, { ...frame.msg, pending: false }],
                  thinking: false,
                },
              }
            : p,
        );
      } else if (frame.type === "newLead") {
        setGlowLeadId(frame.lead.id);
        triggerStream(frame.lead.id);
        setSnap((s) => (s ? { ...s, leads: [frame.lead, ...s.leads] } : s));
        setEvents((e) => [
          { id: Date.now(), kind: "scrape", icon: "lead", text: `New node: ${frame.lead.company}`, datum: String(frame.lead.score), createdAt: Math.floor(Date.now() / 1000) },
          ...e,
        ]);
      }
    },
    [triggerStream],
  );

  // Bootstrap from SSR snapshot once.
  useEffect(() => {
    void getSnapshot().then((s) => {
      setSnap(s);
      setEvents(s.events);
      setMetrics(s.metrics);
      setActiveLeadId(s.activeLeadId);
    });
  }, []);

  // Subscribe to the live hub.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const es = new EventSource("/api/events");
      es.onmessage = (ev) => {
        try {
          applyFrame(JSON.parse(ev.data) as LiveFrame);
        } catch {
          /* ignore malformed */
        }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
      };
      esRef.current = es;
      return () => es.close();
    } catch {
      /* SSE unsupported; app works via refetch-on-mutation */
    }
  }, [applyFrame]);

  // ---------- multi-thread actions ----------
  const selectLead = useCallback(
    (id: string) => {
      if (!id) return;
      // open (or focus) a floating conversation window for this lead
      setOpenIds((p) => (p.includes(id) ? p : [...p, id]));
      setThreads((p) =>
        p[id]
          ? p
          : { ...p, [id]: { lead: null, messages: [], chatState: "typing", thinking: false } },
      );
      setActiveLeadId(id);
      void focusNode({ data: { leadId: id } }).catch(() => {});
      void getLeadThread({ data: { leadId: id } }).then(({ lead, msgs }) =>
        patchThread(id, { lead, messages: msgs, chatState: "typing" }),
      );
    },
    [patchThread],
  );

  const activateChat = useCallback((id: string) => {
    setActiveLeadId(id);
  }, []);

  const closeChat = useCallback(
    (id: string) => {
      setOpenIds((p) => p.filter((x) => x !== id));
      setThreads((p) => {
        const c = { ...p };
        delete c[id];
        return c;
      });
      setActiveLeadId((a) => (a === id ? null : a));
    },
    [],
  );

  const closeAllChats = useCallback(() => {
    setOpenIds([]);
    setThreads({});
    setActiveLeadId(null);
  }, []);

  const sendTo = useCallback(
    async (id: string, text: string) => {
      const t = text.trim();
      if (!t || !openIds.includes(id)) return null;
      patchThread(id, { chatState: "sending", thinking: true });
      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        leadId: id,
        role: "user",
        kind: "chat",
        body: t,
        badge: null,
        createdAt: Math.floor(Date.now() / 1000),
        pending: true,
      };
      setThreads((p) =>
        p[id]
          ? { ...p, [id]: { ...p[id], messages: [...p[id].messages, optimistic], chatState: "sending", thinking: true } }
          : p,
      );
      try {
        const { reply } = await sendChat({ data: { leadId: id, text: t } });
        setThreads((p) =>
          p[id]
            ? {
                ...p,
                [id]: {
                  ...p[id],
                  messages: p[id].messages
                    .map((m) => (m.id === optimistic.id ? { ...m, pending: false } : m))
                    .concat(p[id].messages.some((m) => m.id === reply.id) ? [] : [{ ...reply, pending: false }]),
                  chatState: "typing",
                  thinking: false,
                },
              }
            : p,
        );
        triggerStream(id);
        return reply.body;
      } catch {
        setThreads((p) =>
          p[id] ? { ...p, [id]: { ...p[id], messages: p[id].messages.filter((m) => m.id !== optimistic.id), chatState: "typing", thinking: false } } : p,
        );
        return null;
      }
    },
    [openIds, patchThread, triggerStream],
  );

  // spider-thread replies (nudge / open the thread window to show them)
  const queueNudge = useCallback(async (leadId: string) => {
    if (!openIds.includes(leadId)) selectLead(leadId);
    patchThread(leadId, { thinking: true });
    try {
      await sendAutomationReply({ data: { leadId } });
    } finally {
      patchThread(leadId, { thinking: false });
    }
  }, [openIds, patchThread, selectLead]);

  const moveStage = useCallback(
    async (stage: Lead["stage"]) => {
      if (!activeLeadId) return;
      await setLeadStageFn({ data: { leadId: activeLeadId, stage } });
    },
    [activeLeadId],
  );

  const noShow = useCallback(async () => {
    if (!activeLeadId) return;
    await markNoShow({ data: { leadId: activeLeadId } });
  }, [activeLeadId]);

  const sweep = useCallback(async () => {
    setHunterSweeping(true);
    try {
      const { lead } = await runHunter({ data: {} });
      setTimeout(() => void selectLead(lead.id), 600);
      triggerStream(lead.id);
    } finally {
      setTimeout(() => setHunterSweeping(false), 1400);
    }
  }, [selectLead, triggerStream]);

  const proposal = useCallback(async () => {
    if (!activeLeadId) return;
    setProposing(true);
    try {
      await makeProposal({ data: { leadId: activeLeadId } });
    } finally {
      setTimeout(() => setProposing(false), 1200);
    }
  }, [activeLeadId]);

  const toggle = useCallback(async (which: "hunter" | "outreach", on: boolean) => {
    await toggleAutomation({ data: { which, on } });
  }, []);

  const leads = snap?.leads ?? [];

  return {
    snap, events, metrics, leads,
    // multi-thread chat
    threads, openIds, activeLeadId,
    activateChat, closeChat, closeAllChats, selectLead, sendTo, queueNudge,
    // brain
    glowLeadId, stream, triggerStream,
    // ops
    hunterSweeping, proposing, sweep, proposal, toggle,
    moveStage, noShow,
    // derived
    thinking: nativeSpeaking || Object.values(threads).some((t) => t.thinking),
    nativeSpeaking, setNativeSpeaking,
    activeLead: threads[activeLeadId ?? ""]?.lead ?? null,
    STAGE_LABEL,
  };
}
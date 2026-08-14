// Floating conversation window. Every open lead gets its own draggable window
// that floats over the whole interface — move it anywhere, open as many as you
// like, raise one to focus with a click.
"use client";
import { useEffect, useRef, useState } from "react";
import type { Lead, Slot } from "../lib/types";
import type { ChatMessage, ChatState } from "../lib/store";
import { tstamp } from "../lib/utils";
import { bookSlotFn } from "../lib/cortex";

export function ChatWindow({
  lead,
  messages,
  state,
  thinking,
  active,
  initialPos,
  onSend,
  onClose,
  onFocus,
}: {
  lead: Lead | null;
  messages: ChatMessage[];
  state: ChatState;
  thinking: boolean;
  active: boolean;
  initialPos: { x: number; y: number };
  onSend: (text: string) => void;
  onClose: () => void;
  onFocus: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [pos, setPos] = useState(initialPos);
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, lead?.id]);

  useEffect(() => {
    if (lead) setTimeout(() => inputRef.current?.focus(), 80);
    setDraft("");
  }, [lead?.id]);

  if (!lead) return null;

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  };

  const headerPointerDown = (e: { clientX: number; clientY: number; target: EventTarget }) => {
    if (e.target instanceof HTMLElement && e.target.closest("button")) return;
    onFocus();
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: PointerEvent) => {
      if (!drag.current) return;
      const w = window.innerWidth, h = window.innerHeight;
      const nx = Math.min(Math.max(0, ev.clientX - drag.current.dx), w - 300);
      const ny = Math.min(Math.max(0, ev.clientY - drag.current.dy), h - 60);
      setPos({ x: nx, y: ny });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const header = (
    <div
      onPointerDown={headerPointerDown}
      className="flex cursor-grab select-none items-center justify-between border-b border-white/5 px-3 py-2 active:cursor-grabbing"
      style={{ touchAction: "none" }}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#00f2fe]">Automation thread</div>
        <div className="truncate font-mono text-[9px] text-[#7d8b97]">
          {lead.company} · score {lead.score} · {lead.channel}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className={`chip ${thinking ? "chip-magenta pulse" : state === "sending" ? "chip-cyan" : "chip-cyan"}`}>
          {thinking ? "THINKING" : state === "sending" ? "SENDING" : "LIVE"}
        </span>
        <button onClick={onClose} aria-label="Close thread" className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-[#8b98a5] hover:bg-white/5">
          ✕
        </button>
      </div>
    </div>
  );

  return (
    <div
      onPointerDown={onFocus}
      className="glass hud-frame pointer-events-auto absolute flex w-[300px] max-w-[88vw] flex-col overflow-hidden rounded-lg shadow-2xl shadow-black/60"
      style={{ left: pos.x, top: pos.y, zIndex: active ? 45 : 35 }}
    >
      {header}
      <div ref={feedRef} className="feed max-h-[46vh] min-h-[120px] flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="font-mono text-[10px] text-[#5c6b78]">Loading thread…</div>
        ) : null}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} leadName={lead.name} />
        ))}
        {thinking ? (
          <div className="msg-in flex items-start gap-2">
            <JarvisAvatar />
            <div className="rounded-md border border-[#ff007f]/20 bg-[#ff007f]/5 px-3 py-2">
              <JarvisDots />
            </div>
          </div>
        ) : null}
      </div>
      <div className="border-t border-white/5 p-3">
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-2.5 py-2 focus-within:border-[#00f2fe]/50">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Message ${lead.company}…`}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[#e8eef4] placeholder-[#5c6b78] outline-none"
            maxLength={2000}
          />
          <button
            onClick={submit}
            disabled={!draft.trim() || state === "sending"}
            className="rounded bg-[#00f2fe]/15 px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider text-[#00f2fe] transition-all hover:bg-[#00f2fe]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            SEND
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between font-mono text-[8.5px] tracking-wider text-[#5c6b78]">
          <span>JARVIS AUTO-REPLY: ON</span>
          <span>ENTER TO SEND · DRAG TO MOVE</span>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, leadName }: { m: ChatMessage; leadName: string }) {
  const isUser = m.role === "user";
  const isJarvis = m.role === "jarvis";
  const badgeColor = (b: string | null) =>
    b === "ACTIVE" ? "chip-cyan" : b === "SCRAPED" ? "chip-cyan" : b === "SENT" ? "chip-cyan" : b ? "chip-magenta" : "chip-cyan";

  let body = m.body;
  let slots: Slot[] = [];
  if (isJarvis && m.body.includes("__SLOTS__")) {
    const [text, rest] = m.body.split("__SLOTS__");
    body = text.trim();
    try {
      slots = JSON.parse(rest.trim()) as Slot[];
    } catch {
      slots = [];
    }
  }

  const [booking, setBooking] = useState(false);
  const [bookedTs, setBookedTs] = useState<number | null>(null);

  const pick = async (ts: number) => {
    if (booking) return;
    setBooking(true);
    try {
      await bookSlotFn({ data: { leadId: m.leadId, startTs: ts } });
      setBookedTs(ts);
    } catch {
      setBooking(false);
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className={`msg-in flex items-start gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      {isJarvis ? <JarvisAvatar /> : <GenericAvatar user={isUser} name={leadName} />}
      <div className={`max-w-[80%] ${isUser ? "items-end" : "items-start"} flex flex-col`}>
        <div
          className={`rounded-md border px-3 py-2 text-[12px] leading-5 ${
            isUser
              ? "border-[#00f2fe]/25 bg-[#00f2fe]/10 text-[#d9f8fb] " + (m.pending ? "opacity-60" : "")
              : isJarvis
                ? "border-[#ff007f]/20 bg-[#ff007f]/[0.07] text-[#f1d8e4]"
                : "border-white/10 bg-white/[0.04] text-[#d5dde4]"
          }`}
        >
          <div>{body}</div>
          {slots.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {slots.map((s) => {
                const booked = bookedTs === s.ts;
                return (
                  <button
                    key={s.ts}
                    onClick={() => void pick(s.ts)}
                    disabled={s.taken || bookedTs !== null || booking}
                    className={`chip transition-all ${booked ? "chip-cyan" : s.taken ? "opacity-40 line-through" : "chip-magenta hover:bg-[#ff007f]/20"}`}
                  >
                    {booked ? "BOOKED · " : ""}{s.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {m.badge ? <span className={`ml-2 chip ${badgeColor(m.badge)}`}>{m.badge}</span> : null}
        </div>
        <div className="mt-0.5 font-mono text-[8.5px] tracking-wider text-[#5c6b78]">
          {isUser ? "YOU" : isJarvis ? "JARVIS" : leadName.toUpperCase()} · {tstamp(m.createdAt)}
        </div>
      </div>
    </div>
  );
}

function JarvisAvatar() {
  return (
    <div className="relative mt-0.5 h-6 w-6 shrink-0">
      <div className="absolute inset-0 rounded-full border border-[#ff007f]/60" />
      <div className="absolute inset-[3px] rounded-full bg-[#ff007f]/15" />
      <div className="absolute inset-[7px] rounded-full bg-[#ff007f]" style={{ boxShadow: "0 0 8px #ff007f" }} />
    </div>
  );
}

function GenericAvatar({ user, name }: { user: boolean; name: string }) {
  const initial = user ? "Y" : (name[0] ?? "L").toUpperCase();
  return (
    <div
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-semibold"
      style={{ borderColor: user ? "rgba(0,242,254,0.5)" : "rgba(255,255,255,0.15)", background: user ? "rgba(0,242,254,0.12)" : "rgba(255,255,255,0.05)", color: user ? "#00f2fe" : "#8b98a5" }}
    >
      {initial}
    </div>
  );
}

function JarvisDots() {
  return (
    <span className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-[#ff007f]" style={{ animation: `pulse-node 1s ${i * 0.15}s infinite` }} />
      ))}
    </span>
  );
}
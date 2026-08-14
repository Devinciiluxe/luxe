// Jarvis voice assistant. Browser speech recognition (STT) for listening and
// speech synthesis (TTS) for Jarvis's reply, plus a hook to plug command
// execution and free-form chat. Everything degrades to "unsupported" rather
// than throwing when the browser can't provide audio.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start: () => void;
  stop: () => void;
}

export function useVoice() {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef<(text: string) => void>(() => {});
  const onInterimRef = useRef<(text: string) => void>(() => {});
  const listeningRef = useRef(false);

  // Embedded inside Jarvis-cortex's native PyQt6 shell (see ui.py's
  // MindMapView), QtWebEngine's Chromium exposes SpeechRecognition in feature
  // detection but has no backing service — calling .start() crashes the
  // entire render process. The native app owns all real voice there anyway,
  // so this hook disables itself rather than ever touching the API.
  const nativeShell = typeof window !== "undefined" && !!(window as any).__JARVIS_NATIVE_SHELL__;
  const SR: any = !nativeShell && typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const hasSpeech = !nativeShell && typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  const hasVoice = !nativeShell && typeof window !== "undefined" && "speechSynthesis" in window;
  const supported = !!SR && hasVoice;

  const setOnFinal = useCallback((fn: (t: string) => void) => {
    onFinalRef.current = fn;
  }, []);
  const setOnInterim = useCallback((fn: (t: string) => void) => {
    onInterimRef.current = fn;
  }, []);

  const start = useCallback(() => {
    if (!supported || listeningRef.current) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let interimText = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (finalText.trim()) {
        const ft = finalText.trim();
        onFinalRef.current(ft);
      }
      if (interimText.trim()) {
        setInterim(interimText.trim());
        onInterimRef.current(interimText.trim());
      } else {
        setInterim("");
      }
    };
    rec.onend = () => {
      listeningRef.current = false;
      setListening(false);
      setInterim("");
    };
    rec.onerror = () => {
      rec.stop();
      listeningRef.current = false;
      setListening(false);
      setInterim("");
    };
    listeningRef.current = true;
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      /* already started; ignore */
    }
  }, [supported, SR]);

  const stop = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setInterim("");
    try {
      recRef.current?.stop();
    } catch {
      /* noop */
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!hasVoice || !text) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.04;
        u.pitch = 0.86;
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find((v) => /Daniel|Google UK English Male|Microsoft Guy|Google US English/i.test(v.name)) || voices.find((v) => v.lang?.startsWith("en"));
        if (preferred) u.voice = preferred;
        u.onstart = () => setSpeaking(true);
        u.onend = () => setSpeaking(false);
        u.onerror = () => setSpeaking(false);
        window.speechSynthesis.speak(u);
      } catch {
        setSpeaking(false);
      }
    },
    [hasVoice],
  );

  const cancelSpeech = useCallback(() => {
    if (hasVoice) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [hasVoice]);

  // keep TTS available after voices load async
  useEffect(() => {
    if (!hasVoice) return;
    const load = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = load;
    load();
  }, [hasVoice]);

  const toggle = useCallback(() => {
    if (listeningRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => {
    stop();
    if (hasVoice) window.speechSynthesis.cancel();
  }, [stop, hasVoice]);

  return { supported, hasVoice, listening, speaking, interim, toggle, start, stop, speak, cancelSpeech, setOnFinal, setOnInterim };
}

// Turn a spoken command into an action. Returns a descriptor the UI can show.
export interface VoiceAction {
  kind: "open" | "propose" | "sweep" | "noshows" | "report" | "pause" | "resume" | "chat";
  leadName?: string;
  text?: string;
}

export function parseCommand(text: string): VoiceAction {
  const t = text.toLowerCase();
  const pick = /(open|show|pull up|talk to|message)\s+(.+)/.exec(text);
  if (/propose|proposal|send a proposal/.test(t)) return { kind: "propose" };
  if (/run (the )?hunter|start (the )?(hunter|sweep)|hunt|sweep|new (leads?|nodes?)/.test(t)) return { kind: "sweep" };
  if (/no[- ]?show|ghost/.test(t)) return { kind: "noshows" };
  if (/report|status|metrics|how.*(doing|pipeline)|numbers/.test(t)) return { kind: "report" };
  if (/\bpause\b/.test(t) && /hunter|hunt/.test(t)) return { kind: "pause" };
  if (/\bresume\b/.test(t) && /hunter|hunt/.test(t)) return { kind: "resume" };
  if (pick && pick[2] && pick[2].length < 60) return { kind: "open", leadName: pick[2] };
  return { kind: "chat", text };
}
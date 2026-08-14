import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/pin")({
  component: PinPage,
});

function PinPage() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const redirectTo =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("redirect") || "/" : "/";

  const submit = async () => {
    if (!pin.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        window.location.href = redirectTo;
        return;
      }
      setError("Wrong PIN. Try again.");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass hud-frame w-full max-w-xs p-6 text-center">
        <div className="mb-1 font-mono text-[10px] tracking-[0.2em] text-[#5c6b78]">JARVIS CORTEX</div>
        <div className="mb-4 font-mono text-[9px] tracking-[0.14em] text-[#7d8b97]">PIN REQUIRED AFTER SIGN-IN</div>
        <div className="space-y-3">
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Enter 4-digit PIN"
            autoFocus
            className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2.5 text-center font-mono text-lg tracking-[0.5em] text-[#e8eef4] placeholder-[#5c6b78] outline-none focus:border-[#00f2fe]/50"
          />
          <button
            onClick={() => void submit()}
            disabled={pin.length < 4 || busy}
            className="w-full rounded-md bg-[#00f2fe]/15 py-2.5 font-mono text-[11px] font-semibold tracking-[0.16em] text-[#00f2fe] transition-colors hover:bg-[#00f2fe]/25 disabled:opacity-40"
          >
            {busy ? "CHECKING…" : "UNLOCK"}
          </button>
          {error ? <div className="font-mono text-[9.5px] text-[#ff007f]">{error}</div> : null}
          <div className="pt-1 font-mono text-[8.5px] text-[#5c6b78]">Set the PIN in app/src/lib/auth.server.ts</div>
        </div>
      </div>
    </div>
  );
}

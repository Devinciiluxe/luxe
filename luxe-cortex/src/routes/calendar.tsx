import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { cancelBookingFn, getBookings } from "../lib/cortex";
import { money } from "../lib/utils";

interface BookingRow {
  id: string;
  lead_id: string;
  start_ts: number;
  duration_min: number;
  status: string;
  notes: string | null;
  company: string;
  name: string;
}

export const Route = createFileRoute("/calendar")({
  loader: async () => getBookings(),
  component: CalendarPage,
});

function CalendarPage() {
  const [rows, setRows] = useState<BookingRow[]>(Route.useLoaderData() as unknown as BookingRow[]);
  const [filter, setFilter] = useState<"upcoming" | "all">("upcoming");

  useEffect(() => {
    getBookings().then((r) => setRows(r as unknown as BookingRow[])).catch(() => {});
  }, [filter]);

  const upcoming = rows.filter((r) => r.start_ts >= Math.floor(Date.now() / 1000) - 3600 && r.status === "confirmed");
  const shown = filter === "upcoming" ? upcoming : rows;

  const cancel = async (id: string) => {
    await cancelBookingFn({ data: { id } });
    setRows((r) => r.map((m) => (m.id === id ? { ...m, status: "canceled" } : m)));
  };

  return (
    <div className="min-h-dvh px-4 py-4 md:px-6">
      <div className="glass hud-frame mx-auto mb-4 flex h-11 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <Link to="/cortex" className="font-mono text-[10px] tracking-[0.18em] text-[#00f2fe] hover:underline">CORTEX</Link>
          <span className="font-mono text-[9px] text-[#5c6b78]">/</span>
          <span className="font-mono text-[10px] tracking-[0.14em] text-[#e8eef4]">BOOKINGS</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilter(filter === "upcoming" ? "all" : "upcoming")}
            className={`chip ${filter === "upcoming" ? "chip-cyan" : ""}`}
          >
            {filter === "upcoming" ? "UPCOMING" : "ALL"}
          </button>
          <span className="chip chip-magenta">{upcoming.length} BOOKED</span>
        </div>
      </div>

      <div className="glass hud-frame mx-auto max-w-5xl divide-y divide-white/[0.05]">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <div className="font-mono text-[11px] tracking-[0.2em] text-[#5c6b78]">NO BOOKINGS ON THE BOARD</div>
            <div className="text-xs text-[#7d8b97]">
              Open a lead's chat and type "book me" — Jarvis will drop slots you can lock with one click.
            </div>
          </div>
        ) : (
          shown.map((r) => {
            const d = new Date(r.start_ts * 1000);
            const inPast = r.start_ts < Math.floor(Date.now() / 1000);
            return (
              <div key={r.id} className={`flex items-center gap-4 px-5 py-4 ${r.status !== "confirmed" ? "opacity-40" : ""}`}>
                <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-md border border-[#00f2fe]/25 bg-[#00f2fe]/[0.06]">
                  <div className="font-mono text-[9px] uppercase tracking-wider text-[#00f2fe]">{d.toLocaleDateString("en-US", { weekday: "short" })}</div>
                  <div className="font-mono text-xl font-semibold text-[#e8f6f7]">{d.getDate()}</div>
                  <div className="font-mono text-[9px] text-[#7d8b97]">{d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[#e8f6f7]">{r.company}</div>
                  <div className="truncate font-mono text-[10px] text-[#7d8b97]">{r.name} · {r.duration_min} min</div>
                  {r.notes ? <div className="mt-0.5 truncate text-[11px] text-[#8b98a5]">{r.notes}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  {r.status === "confirmed" && !inPast ? (
                    <span className="chip chip-cyan">CONFIRMED</span>
                  ) : r.status === "canceled" ? (
                    <span className="chip chip-amber">CANCELED</span>
                  ) : (
                    <span className="chip chip-magenta">DONE</span>
                  )}
                  {r.status === "confirmed" && !inPast ? (
                    <button
                      onClick={() => void cancel(r.id)}
                      className="rounded border border-white/10 px-2.5 py-1 font-mono text-[9px] text-[#ff9f43] hover:border-[#ff9f43]/50 hover:bg-[#ff9f43]/10 transition-colors"
                    >
                      CANCEL
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="glass hud-frame mx-auto mt-4 max-w-5xl px-5 py-4">
        <div className="hud-title mb-2">How booking works</div>
        <ol className="space-y-1 text-[12px] text-[#8b98a5]">
          <li>1. Open any lead on the map.</li>
          <li>2. Type "book me" / "schedule" / "call" in the thread.</li>
          <li>3. Jarvis offers 3 live slots as clickable buttons. Click one and the meeting lands here.</li>
        </ol>
      </div>
    </div>
  );
}

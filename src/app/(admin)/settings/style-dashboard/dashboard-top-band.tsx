"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  GenerationQueue,
  GenerationThroughput,
  QueueItem,
  DashboardWindow,
} from "@/lib/dashboard/style-dashboard";

// Polls fast while the queue has work, slow when idle — same spirit as the
// SharePoint upload-progress widget.
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 20_000;

const WINDOW_LABEL: Record<DashboardWindow, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
};
const WINDOWS: DashboardWindow[] = ["1h", "24h", "7d"];

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function ageSeconds(item: QueueItem, nowMs: number): number {
  const sinceIso = item.status === "RUNNING" ? (item.startedAt ?? item.waitingSince) : item.waitingSince;
  return Math.max(0, Math.floor((nowMs - Date.parse(sinceIso)) / 1000));
}

export function DashboardTopBand({
  initialQueue,
  initialThroughput,
}: {
  initialQueue: GenerationQueue;
  initialThroughput: GenerationThroughput;
}) {
  const [queue, setQueue] = useState<GenerationQueue>(initialQueue);
  const [throughput, setThroughput] = useState<GenerationThroughput>(initialThroughput);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  // Imperative "poll now" — Run All pokes this so the drain shows up immediately
  // instead of waiting for the next scheduled tick.
  const pokeNow = useRef<() => void>(() => {});

  const inFlight = queue.queued + queue.running;

  // Self-rescheduling poll: fast while the queue has work, slow when idle. A
  // hoisted function declaration (not a useCallback) so it can reference itself
  // for the next tick without an "accessed before declared" cycle.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function run() {
      if (cancelled) return;
      let busy = false;
      try {
        const res = await fetch("/api/admin/style-dashboard/live", { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as { queue: GenerationQueue; throughput: GenerationThroughput };
          if (!cancelled) {
            setQueue(next.queue);
            setThroughput(next.throughput);
          }
          busy = next.queue.queued + next.queue.running > 0;
        }
      } catch {
        // transient — retry on the idle cadence
      }
      if (!cancelled) timer = setTimeout(run, busy ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }
    pokeNow.current = () => {
      if (timer) clearTimeout(timer);
      void run();
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Tick the clock once a second so item ages count up between polls — only
  // while something is in flight (no idle re-renders).
  useEffect(() => {
    if (inFlight === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [inFlight]);

  async function runAll() {
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await fetch("/api/jobs/run?sweep=1&limit=20", { method: "POST" });
      if (res.ok) {
        const r = (await res.json()) as { processed?: number; sweepEnqueued?: number; skipped?: boolean };
        setRunMsg(
          r.skipped
            ? "A drain is already running — it will keep going."
            : `Swept ${r.sweepEnqueued ?? 0} in · processing ${r.processed ?? 0}. Draining…`,
        );
      } else {
        setRunMsg(`Failed (${res.status}).`);
      }
    } catch {
      setRunMsg("Request failed.");
    } finally {
      setRunning(false);
      pokeNow.current(); // reflect the drain immediately
    }
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-3">
      {/* Throughput */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Throughput</div>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-xs text-zinc-400">
              <th className="pb-1 text-left font-medium" />
              {WINDOWS.map((w) => (
                <th key={w} className="pb-1 text-right font-medium tabular-nums">
                  {WINDOW_LABEL[w]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-1 text-zinc-600">Generated</td>
              {WINDOWS.map((w) => (
                <td key={w} className="py-1 text-right font-semibold tabular-nums text-zinc-900">
                  {throughput[w].generated.toLocaleString()}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-1 text-zinc-600">Sent to supplier</td>
              {WINDOWS.map((w) => (
                <td key={w} className="py-1 text-right font-semibold tabular-nums text-zinc-900">
                  {throughput[w].sent.toLocaleString()}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <div className="mt-2 text-[11px] text-zinc-400">
          Generated = documents rendered · Sent = outputs emailed to the supplier.
        </div>
      </div>

      {/* Live queue + Run All */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Generation queue
          </div>
          <div className="flex items-center gap-3">
            {runMsg && <span className="text-xs text-zinc-500">{runMsg}</span>}
            <button
              type="button"
              onClick={runAll}
              disabled={running}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              title="Sweep ready-but-ungenerated outputs into the queue, then drain it (keeps approved outputs)."
            >
              {running ? "Running…" : "Run all (unclog)"}
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-2xl font-semibold tracking-tight tabular-nums text-zinc-900">
            {queue.running}
          </span>
          <span className="text-sm text-zinc-500">generating</span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums text-zinc-900">
            {queue.queued}
          </span>
          <span className="text-sm text-zinc-500">queued</span>
          {queue.oldestWaitSeconds != null && inFlight > 0 && (
            <span className="ml-auto text-xs text-zinc-500">
              oldest wait{" "}
              <span className={queue.oldestWaitSeconds > 900 ? "font-semibold text-amber-700" : "text-zinc-700"}>
                {formatAge(queue.oldestWaitSeconds)}
              </span>
            </span>
          )}
        </div>

        {inFlight === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-500">
            Nothing generating right now.
          </div>
        ) : (
          <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto">
            {queue.items.map((it) => {
              const age = ageSeconds(it, nowMs);
              return (
                <li
                  key={it.jobId}
                  className="flex items-center justify-between gap-3 rounded-md border border-zinc-100 px-2.5 py-1.5 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        it.status === "RUNNING" ? "bg-blue-500" : "bg-amber-400"
                      }`}
                      aria-hidden="true"
                    />
                    <Link href={`/styles/${it.styleId}`} className="truncate font-medium text-zinc-800 hover:underline">
                      {it.styleName}
                    </Link>
                    {it.poNumber && <span className="shrink-0 text-zinc-400">PO {it.poNumber}</span>}
                    <span className="shrink-0 text-zinc-400">
                      {it.outputCount == null ? "all outputs" : `${it.outputCount} output${it.outputCount === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums">
                    <span className={it.status === "RUNNING" ? "text-blue-700" : "text-amber-700"}>
                      {it.status === "RUNNING" ? "generating" : "queued"}
                    </span>
                    <span className="text-zinc-500">{formatAge(age)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

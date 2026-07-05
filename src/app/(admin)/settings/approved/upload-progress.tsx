"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Live progress for the SharePoint upload sweep. Polls the progress endpoint
// (fast while work is pending, slow when idle — same spirit as the bulk-run
// widget on /styles) and renders a segmented bar over tonight's queue:
// uploaded (green) · failed (red) · skipped (grey) · still pending (amber),
// plus throughput + ETA derived from the recent cron sweep ticks.

type Progress = {
  uploaded: number;
  pending: number;
  failed: number;
  skipped: number;
  floated: number;
  ratePerMin: number | null;
  lastTick: {
    at: string;
    uploaded: number;
    failed: number;
    backfilled: number;
    durationMs: number | null;
    skippedRun: boolean;
  } | null;
};

const ACTIVE_POLL_MS = 8_000;
const IDLE_POLL_MS = 45_000;

export function UploadProgress({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [p, setP] = useState<Progress | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refresh the server-rendered tables once per transition into "drained".
  const wasPending = useRef(false);

  const tick = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/supplier-send/progress", { cache: "no-store" });
      if (res.ok) {
        const next = (await res.json()) as Progress;
        setP(next);
        if (wasPending.current && next.pending === 0) router.refresh();
        wasPending.current = next.pending > 0;
        timer.current = setTimeout(tick, next.pending > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        return;
      }
    } catch {
      // transient — fall through to a slow retry
    }
    timer.current = setTimeout(tick, IDLE_POLL_MS);
  }, [router]);

  useEffect(() => {
    void tick();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tick]);

  if (!p) return null;

  const total = p.uploaded + p.pending + p.failed + p.skipped;
  if (total === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">
        Nothing in tonight&rsquo;s queue — new approvals appear here as they&rsquo;re captured.
      </div>
    );
  }

  const pct = (n: number) => `${(100 * n) / total}%`;
  const done = p.pending === 0;
  const eta =
    p.pending > 0 && p.ratePerMin && p.ratePerMin > 0
      ? Math.max(1, Math.round(p.pending / p.ratePerMin))
      : null;
  const lastTickAgeMin = p.lastTick
    ? Math.max(0, Math.round((Date.now() - new Date(p.lastTick.at).getTime()) / 60_000))
    : null;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-zinc-900">
          SharePoint uploads —{" "}
          <span className="tabular-nums">
            {p.uploaded}/{total}
          </span>{" "}
          <span className="font-normal text-zinc-500">
            {done ? "done" : `uploaded · ${p.pending} to go`}
          </span>
        </div>
        <div className="text-xs text-zinc-500">
          {!enabled && p.pending > 0 ? (
            <span className="text-amber-600">sending is OFF — uploads paused</span>
          ) : done ? (
            "queue settled"
          ) : (
            <>
              {p.ratePerMin ? `~${Math.round(p.ratePerMin)}/min` : "waiting for first sweep"}
              {eta ? ` · ETA ~${eta} min` : ""}
            </>
          )}
        </div>
      </div>

      <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-amber-100">
        <div className="h-full bg-emerald-500 transition-all duration-700" style={{ width: pct(p.uploaded) }} />
        <div className="h-full bg-red-400 transition-all duration-700" style={{ width: pct(p.failed) }} />
        <div className="h-full bg-zinc-300 transition-all duration-700" style={{ width: pct(p.skipped) }} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span className="tabular-nums">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />
          {p.uploaded} uploaded
        </span>
        <span className="tabular-nums">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-300" />
          {p.pending} pending
        </span>
        <span className="tabular-nums">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-400" />
          {p.failed} failed{p.floated > 0 ? ` (${p.floated} gave up)` : ""}
        </span>
        <span className="tabular-nums">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-zinc-300" />
          {p.skipped} skipped
        </span>
        {p.lastTick ? (
          <span className="ml-auto">
            last sweep {lastTickAgeMin === 0 ? "just now" : `${lastTickAgeMin} min ago`}
            {p.lastTick.skippedRun
              ? " (sending off)"
              : p.lastTick.uploaded > 0
                ? ` — ${p.lastTick.uploaded} in ${p.lastTick.durationMs != null ? `${Math.round(p.lastTick.durationMs / 1000)}s` : "?"}${p.lastTick.backfilled > 0 ? `, +${p.lastTick.backfilled} backfilled` : ""}`
                : ""}
          </span>
        ) : (
          <span className="ml-auto">no sweep recorded yet — first cron tick pending</span>
        )}
      </div>
    </div>
  );
}

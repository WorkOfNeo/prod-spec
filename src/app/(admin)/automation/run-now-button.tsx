"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Fires the same two endpoints the Railway cron hits — EAN sweep then the
// generation sweep + job drain — but session-authed, so it always runs
// regardless of the cron. Shows each call's result, then refreshes the page.
type RunResult = { label: string; ok: boolean; detail: string };

export function RunNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);

  async function hit(label: string, url: string): Promise<RunResult> {
    try {
      const res = await fetch(url, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { label, ok: false, detail: `HTTP ${res.status}` };
      if (data.skipped) return { label, ok: true, detail: `skipped — ${String(data.reason ?? "switch off")}` };
      const parts = (["processed", "failed", "requeued", "sweepEnqueued"] as const)
        .filter((k) => typeof data[k] === "number")
        .map((k) => `${k}=${data[k]}`);
      return { label, ok: true, detail: parts.join(" · ") || "ok" };
    } catch (e) {
      return { label, ok: false, detail: e instanceof Error ? e.message : "failed" };
    }
  }

  async function run() {
    setBusy(true);
    setResults([]);
    // EAN first so anything it resolves is queued for the generation sweep.
    const ean = await hit("PO barcodes", "/api/po-eans/run?sweep=1&limit=20");
    setResults([ean]);
    const jobs = await hit("Generation", "/api/jobs/run?sweep=1&limit=20");
    setResults([ean, jobs]);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="shrink-0 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
      >
        {busy ? "Running…" : "Run now"}
      </button>
      {results.map((r) => (
        <div key={r.label} className={`text-xs ${r.ok ? "text-zinc-500" : "text-red-600"}`}>
          {r.label}: {r.detail}
        </div>
      ))}
    </div>
  );
}

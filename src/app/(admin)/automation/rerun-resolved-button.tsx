"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Re-queues all already-resolved styles (RESOLVED / PARTIAL) so the runner
// re-scrapes them with the latest matching logic. The sweep never touches
// resolved rows, so this is the only way to re-apply a parser change to the
// back-catalogue. Drains via the cron / "Run now" afterwards.
export function RerunResolvedButton({ count, cutoff }: { count: number; cutoff: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    if (count === 0) return;
    const scope = cutoff !== null ? ` (PO ≥ ${cutoff})` : "";
    const ok = window.confirm(
      `Re-run EAN resolution for ${count} already-resolved style${count === 1 ? "" : "s"}${scope}?\n\n` +
        "Each re-scrapes its PO with the latest matching logic. Current barcodes stay " +
        'until a row actually re-resolves. They drain via the cron — or press "Run now".',
    );
    if (!ok) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/po-eans/rerun-resolved", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) setResult({ ok: false, text: `failed — HTTP ${res.status}` });
      else setResult({ ok: true, text: `re-queued ${data.requeued ?? 0} — drain via cron or Run now` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "failed" });
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy || count === 0}
        className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
      >
        {busy ? "Re-queuing…" : `Re-run resolved${count > 0 ? ` (${count})` : ""}`}
      </button>
      {result && (
        <div className={`text-xs ${result.ok ? "text-zinc-500" : "text-red-600"}`}>{result.text}</div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-row review toggle on /combos. PATCHes the status and refreshes the
// server component so the pill + ordering update. Mirrors the fetch/loading
// shape of review-notification-email-setting.tsx (the app uses API routes +
// fetch, not server actions).
export function ComboRowActions({ id, status }: { id: string; status: "NEW" | "REVIEWED" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = status === "NEW" ? "REVIEWED" : "NEW";

  async function flip() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/combos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `Failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
      <button
        type="button"
        onClick={flip}
        disabled={busy}
        className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "…" : status === "NEW" ? "Mark reviewed" : "Mark new"}
      </button>
    </span>
  );
}

// Header "Rescan now" — runs the same reconcile the cron/sync use. The admin
// session satisfies isCronAuthorized, so no secret is needed from the UI.
export function RescanCombosButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function rescan() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/cron/detect-combos`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        created?: number;
        notified?: number;
      };
      if (!res.ok) throw new Error(j.error ?? `Failed (${res.status})`);
      const created = typeof j.created === "number" ? j.created : 0;
      const notified = typeof j.notified === "number" ? j.notified : 0;
      setResult(
        created > 0
          ? `${created} new · ${notified} alert${notified === 1 ? "" : "s"} staged`
          : "Up to date",
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result ? <span className="text-xs text-emerald-600">{result}</span> : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
      <button
        type="button"
        onClick={rescan}
        disabled={busy}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {busy ? "Rescanning…" : "Rescan now"}
      </button>
    </div>
  );
}

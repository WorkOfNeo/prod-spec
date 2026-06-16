"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Per-row actions on /combos. "Create" builds the ProdSpec for this combo
// (pre-named "<Customer> - <Business area> - ") and drops you into the editor;
// once a spec exists the button becomes "Open spec". A combo with no business
// area can't have a spec, so Create is disabled there. The combo's New/Ready
// status is derived from that spec (active + enabled outputs) — there's no
// manual review toggle. Mirrors the fetch/loading shape the app uses elsewhere
// (API routes + fetch, not server actions).
export function ComboRowActions({
  id,
  hasBusinessArea,
  existingSpecId,
}: {
  id: string;
  hasBusinessArea: boolean;
  existingSpecId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createSpec() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/combos/${id}/prod-spec`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { error?: string; prodSpecId?: string };
      if (!res.ok || !j.prodSpecId) throw new Error(j.error ?? `Failed (${res.status})`);
      // Land in the editor with the name prefix filled. No setBusy(false) —
      // we're navigating away.
      router.push(`/prod-specs/${j.prodSpecId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error ? <span className="text-xs text-red-600">{error}</span> : null}

      {existingSpecId ? (
        <Link
          href={`/prod-specs/${existingSpecId}`}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Open spec
        </Link>
      ) : (
        <button
          type="button"
          onClick={createSpec}
          disabled={busy || !hasBusinessArea}
          title={
            hasBusinessArea
              ? "Create a ProdSpec named “Customer - Business area - ” and open it"
              : "No business area to base a ProdSpec on"
          }
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      )}
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

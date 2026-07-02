"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Undo for a per-style output ignore — shown next to the "Ignored" pill in
// the review page's excluded section. Deleting the ignore puts the output
// back in the normal flow: an existing asset resurfaces for review, an
// un-generated one becomes eligible for auto-generation again.
export function UndoIgnoreButton({
  styleId,
  variantKey,
}: {
  styleId: string;
  variantKey: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function undo() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/styles/${styleId}/output-ignores?variantKey=${encodeURIComponent(variantKey)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={undo}
        disabled={busy}
        title="Stop ignoring this output for this style"
        className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Undoing…" : "Undo ignore"}
      </button>
      {err ? <span className="text-[11px] text-red-600">{err}</span> : null}
    </span>
  );
}

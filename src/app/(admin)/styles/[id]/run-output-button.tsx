"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Per-output "Run" — enqueues a job scoped to one variantKey via the rerun
// endpoint and renders it inline (the endpoint runs the queue before
// responding). Not-ready outputs render the button disabled/faded with the
// missing fields in the tooltip.
export function RunOutputButton({
  styleId,
  variantKey,
  ready,
  missingLabels,
}: {
  styleId: string;
  variantKey: string;
  ready: boolean;
  missingLabels: string[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKeys: [variantKey] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={!ready || pending}
        title={
          ready
            ? "Generate this output now"
            : `Not ready — missing: ${missingLabels.join(", ") || "required fields"}`
        }
        className={`rounded-md border px-3 py-1 text-xs font-medium ${
          ready
            ? "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
            : "cursor-not-allowed border-zinc-200 bg-zinc-50 text-zinc-300"
        } disabled:opacity-60`}
      >
        {pending ? "Running…" : "Run"}
      </button>
    </div>
  );
}

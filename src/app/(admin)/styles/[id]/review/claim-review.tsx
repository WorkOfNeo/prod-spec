"use client";

// Test-phase claim flow (see lib/review-flow/flags.ts). Two jobs:
//
//   1. The chip — when the job is claimed, the header shows who owns the
//      review and since when ("the status in the top box").
//   2. The popup — on an UNCLAIMED review with pending documents, after the
//      reviewer has been on the page ~10 seconds we ask them to take
//      responsibility. "Yes" stamps the claim (first writer wins), which
//      arms the leave guard and pins the job to their My tasks even before
//      the first approve/reject click.
//
// "Not yet" just closes it for this visit — it re-asks on the next visit,
// and the first decision claims implicitly anyway (see claim.ts).

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/time";

const CLAIM_PROMPT_DELAY_MS = 10_000;

export function ReviewClaim({
  jobId,
  pendingCount,
  claimedByName,
  claimedByMe,
  claimedAtIso,
  styleContext,
}: {
  jobId: string;
  pendingCount: number;
  // null ⇒ nobody has claimed this review yet.
  claimedByName: string | null;
  claimedByMe: boolean;
  claimedAtIso: string | null;
  styleContext: string;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unclaimed = claimedByName === null;

  useEffect(() => {
    if (!unclaimed || pendingCount === 0) return;
    const t = window.setTimeout(() => setPrompt(true), CLAIM_PROMPT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [unclaimed, pendingCount]);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/claim-review`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // Claimed (or someone beat us to it) — either way the server state
      // changed; re-render shows the chip with the standing owner.
      setPrompt(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {claimedByName !== null ? (
        <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          In review · {claimedByMe ? "you" : claimedByName}
          {claimedAtIso ? <> · {timeAgo(new Date(claimedAtIso))}</> : null}
        </span>
      ) : null}

      {prompt && unclaimed ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPrompt(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-900">Start reviewing this prod spec?</h3>
            <p className="mt-0.5 text-xs text-zinc-500">{styleContext}</p>
            <p className="mt-3 text-sm text-zinc-700">
              Pressing yes marks this review as <b>in review by you</b> — it stays on your{" "}
              <b>My tasks</b> until every document is approved or rejected, so a half-finished
              check can&rsquo;t be forgotten.
            </p>
            {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPrompt(false)}
                disabled={busy}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
              >
                Not yet
              </button>
              <button
                type="button"
                autoFocus
                onClick={claim}
                disabled={busy}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy ? "Starting…" : "Yes — start review"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

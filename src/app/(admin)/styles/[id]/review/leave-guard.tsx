"use client";

// Arms the navigation guard while this review is partially decided — ≥1
// document decided (this session or an earlier one) and ≥1 still pending.
// That state is the dangerous one: decisions are persisted per click, but
// NOTHING goes to the supplier until every document is decided, so leaving
// here strands the job in AWAITING_REVIEW with nobody reminded.
//
// Counts come from the server page. asset-actions already router.refresh()es
// after every decision, so arming tracks the DB with no client bookkeeping.
// Decided-nothing visits never prompt (the dashboard's first-review queue
// owns those), and a dismissal suppresses the modal for this job for the
// rest of the browser session — after that, nagging is the badge's job.

import { useState } from "react";
import { useLeaveGuard } from "@/components/navigation-guard";

function storageKey(jobId: string) {
  return `review-guard:${jobId}`;
}

export function ReviewLeaveGuard({
  jobId,
  decided,
  pending,
  claimedByMe,
  styleContext,
}: {
  jobId: string;
  decided: number;
  pending: number;
  // Claiming via the "Start review" popup is taking responsibility too —
  // it arms the guard even before the first approve/reject click.
  claimedByMe: boolean;
  styleContext: string;
}) {
  // One read at mount. During SSR there is no sessionStorage — default to
  // suppressed; arming only ever happens client-side (inside an effect), so
  // hydration output is identical either way.
  const [suppressed, setSuppressed] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.sessionStorage.getItem(storageKey(jobId)) === "1",
  );

  const { prompting, confirmLeave, cancelLeave } = useLeaveGuard({
    when: !suppressed && pending > 0 && (decided > 0 || claimedByMe),
  });

  if (!prompting) return null;
  return (
    <FinishReviewModal
      decided={decided}
      total={decided + pending}
      styleContext={styleContext}
      onLeave={() => {
        window.sessionStorage.setItem(storageKey(jobId), "1");
        setSuppressed(true);
        confirmLeave();
      }}
      onStay={cancelLeave}
    />
  );
}

function FinishReviewModal({
  decided,
  total,
  styleContext,
  onLeave,
  onStay,
}: {
  decided: number;
  total: number;
  styleContext: string;
  onLeave: () => void;
  onStay: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onStay}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-zinc-900">Finish this review before you go?</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{styleContext}</p>
        <p className="mt-3 text-sm text-zinc-700">
          {decided > 0 ? (
            <>
              You&rsquo;ve decided <b>{decided} of {total}</b> documents.
            </>
          ) : (
            <>
              You started this review — <b>none of the {total}</b> documents are decided yet.
            </>
          )}{" "}
          <b>Nothing is sent to the supplier until every document is approved or rejected</b> — if
          you leave now, this review stays open and lands on your <b>My tasks</b> page.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onLeave}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
          >
            Leave — it&rsquo;ll wait on My tasks
          </button>
          <button
            type="button"
            autoFocus
            onClick={onStay}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Keep reviewing
          </button>
        </div>
      </div>
    </div>
  );
}

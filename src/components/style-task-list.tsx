import Link from "next/link";
import { timeAgo, type ReviewTask, type ReviewTaskOutput } from "@/lib/dashboard/review-tasks";
import { outputAnchor } from "@/lib/outputs/current-outputs";

// The per-style review card. Shared by My tasks (/dashboard) and the review
// queue (/reviews) so both render the identical "collected per style" unit —
// the style summary, the "N to review" badge, the right CTA, and the
// expandable list of its FRESH outputs (settled approved/rejected ones are
// hidden here and live on the review page). Server-renderable: <details>/
// <summary> are native, so no "use client" is needed.

const OUTPUT_CHIP: Record<ReviewTaskOutput["state"], { cls: string; label: string }> = {
  APPROVED: { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "approved" },
  REJECTED: { cls: "border-red-200 bg-red-50 text-red-700", label: "rejected" },
  BLOCKED: { cls: "border-amber-200 bg-amber-50 text-amber-800", label: "blocked" },
  TO_REVIEW: { cls: "border-blue-200 bg-blue-50 text-blue-700", label: "to review" },
  // Still-coming states — muted, no action; the document doesn't exist yet.
  GENERATING: { cls: "border-zinc-200 bg-zinc-50 text-zinc-500", label: "generating…" },
  READY_TO_GENERATE: { cls: "border-zinc-200 bg-zinc-50 text-zinc-500", label: "queued" },
  AWAITING_DATA: { cls: "border-zinc-200 bg-zinc-50 text-zinc-500", label: "awaiting data" },
};

function StyleTaskAction({ t, startedContext }: { t: ReviewTask; startedContext: boolean }) {
  if (t.needsPublishRetry) {
    return (
      <Link
        href={`/styles/${t.styleId}/review`}
        className="inline-block rounded-md border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
        title="All documents approved but the publish (SharePoint + supplier email) failed — retry from the review screen"
      >
        Publish failed — retry
      </Link>
    );
  }
  if (t.blocked) {
    return (
      <Link
        href={`/styles/${t.styleId}`}
        className="inline-block rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
        title="Remaining documents contain placeholder artifacts — fix the data and re-run from the style page"
      >
        Blocked — fix &amp; re-run
      </Link>
    );
  }
  return (
    <Link
      href={`/styles/${t.styleId}/review`}
      className="inline-block rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800"
    >
      {t.decided > 0 ? "Finish review" : startedContext ? "Continue review" : "Start review"}
    </Link>
  );
}

// Each style is an expandable row: the summary toggles the accordion of its
// outputs; the action button and the per-output "Review" links navigate to
// the uniform review page (clicking those leaves the page, so the toggle is moot).
export function StyleTaskList({
  tasks,
  activityPrefix,
  // When these rows are reviews already started (the /reviews "In Progress"
  // tab), a claimed-but-undecided style reads "Continue review", not "Start
  // review". Default false keeps the dashboard and the first-review queue as-is.
  startedContext = false,
}: {
  tasks: ReviewTask[];
  activityPrefix: string;
  startedContext?: boolean;
}) {
  return (
    <div className="mt-3 space-y-2">
      {tasks.map((t) => (
        <details key={t.jobId} className="group rounded-lg border border-zinc-200 bg-white">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-zinc-900">{t.styleName}</span>
                {t.businessArea ? (
                  <span className="text-xs text-zinc-500">{t.businessArea}</span>
                ) : null}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {t.customerName}
                {t.poNumber ? ` · PO ${t.poNumber}` : ""} · {activityPrefix}
                {timeAgo(t.lastActivityAt)}
              </div>
            </div>
            {t.total > 0 ? (
              <span className="hidden shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-blue-700 sm:inline-block">
                {t.total} to review
              </span>
            ) : null}
            {t.generatedSlots < t.totalSlots ? (
              <span
                className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-800"
                title={`${t.generatedSlots} of ${t.totalSlots} outputs generated — the remaining ${t.totalSlots - t.generatedSlots} ${t.totalSlots - t.generatedSlots === 1 ? "is" : "are"} still awaiting data or being generated, and appear here automatically when ready.`}
              >
                {t.generatedSlots}/{t.totalSlots} generated
              </span>
            ) : null}
            <StyleTaskAction t={t} startedContext={startedContext} />
          </summary>
          <div className="border-t border-zinc-100 px-3 py-2">
            {t.stillComing > 0 ? (
              <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                {t.stillComing} of {t.outputs.length} output{t.outputs.length === 1 ? "" : "s"}{" "}
                {t.stillComing === 1 ? "isn't" : "aren't"} generated yet — they appear here
                automatically as their data lands or rendering finishes. Nothing is sent to the
                supplier until every output is decided.
              </p>
            ) : null}
            <ul className="space-y-1">
              {t.outputs.map((o) => {
                const chip = OUTPUT_CHIP[o.state];
                return (
                  <li key={o.variantKey} className="flex items-center justify-between gap-3 text-xs">
                    <span
                      className={`min-w-0 truncate ${o.generated ? "text-zinc-700" : "text-zinc-400"}`}
                    >
                      {o.name}
                      {!o.generated && o.state === "AWAITING_DATA" && o.missing.length > 0 ? (
                        <span className="ml-1 text-amber-700">· missing {o.missing.join(", ")}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chip.cls}`}>
                        {chip.label}
                      </span>
                      {o.generated ? (
                        <Link
                          href={`/styles/${t.styleId}/review#${outputAnchor(o.variantKey)}`}
                          className="text-blue-700 hover:underline"
                        >
                          Review
                        </Link>
                      ) : (
                        // No document yet — keep the column aligned, no action.
                        <span className="text-zinc-300" aria-hidden="true">
                          —
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      ))}
    </div>
  );
}

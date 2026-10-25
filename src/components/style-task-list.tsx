import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { timeAgo, type ReviewTask, type ReviewTaskOutput } from "@/lib/dashboard/review-tasks";
import { outputAnchor } from "@/lib/outputs/current-outputs";
import type { StyleCommentCounts } from "@/lib/dashboard/style-comment-counts";
import {
  OutputReadinessNotice,
  type ReadinessHrefs,
} from "@/components/output-readiness-notice";
import { buttonClass } from "@/components/ui/button";
import { Pill, type PillTone } from "@/components/ui/pill";
import { MiniProgress } from "@/components/ui/progress";

// The per-style review row. Shared by My tasks (/dashboard) and the review
// queue (/reviews) so both render the identical "collected per style" unit —
// the style summary, how far the review got, the right action, and an
// expandable list of its outputs with the readiness ladder. Server-renderable:
// <details>/<summary> are native, so no "use client" is needed.

const OUTPUT_STATE: Record<ReviewTaskOutput["state"], { tone: PillTone; label: string }> = {
  APPROVED: { tone: "good", label: "Approved" },
  REJECTED: { tone: "bad", label: "Changes requested" },
  BLOCKED: { tone: "warn", label: "Blocked" },
  TO_REVIEW: { tone: "accent", label: "To review" },
  // Still-coming states — muted, no action; the document doesn't exist yet.
  GENERATING: { tone: "neutral", label: "Generating…" },
  READY_TO_GENERATE: { tone: "neutral", label: "Queued" },
  // Required fields are missing — generation was deliberately skipped (not
  // queued). Amber, not muted: it needs data fixed on Monday before it can run.
  AWAITING_DATA: { tone: "warn", label: "Missing fields" },
  // Decided by a doc-type keyword rule — won't generate. (Excluded outputs
  // never become review assets, so this won't normally appear in the queue;
  // present for type completeness over the full OutputState union.)
  EXCLUDED: { tone: "neutral", label: "Excluded" },
};

// Navigational hrefs for the readiness notice on a review row. Only the keys
// that make sense here are wired: NO `rerun` (these rows have no RerunButton)
// and NO `openSuppliersDrive` (the supplier URL isn't loaded for this surface).
function readinessHrefs(t: ReviewTask): ReadinessHrefs {
  const prodSpecHref = t.prodSpecId ? `/prod-specs/${t.prodSpecId}` : undefined;
  return {
    openMonday: t.mondayUrl,
    openPoEans: "/po-eans",
    review: `/styles/${t.styleId}/review`,
    ...(prodSpecHref
      ? {
          openProdSpec: prodSpecHref,
          setBusinessArea: prodSpecHref,
          pinFieldInSpec: prodSpecHref,
        }
      : {}),
  };
}

function StyleTaskAction({ t, startedContext }: { t: ReviewTask; startedContext: boolean }) {
  if (t.needsPublishRetry) {
    return (
      <Link
        href={`/styles/${t.styleId}/review`}
        className={buttonClass("danger", "sm")}
        title="All documents approved but the publish (SharePoint + supplier email) failed — retry from the review screen"
      >
        Publish failed, retry
      </Link>
    );
  }
  if (t.blocked) {
    return (
      <Link
        href={`/styles/${t.styleId}`}
        className={buttonClass("secondary", "sm")}
        title="Remaining documents contain placeholder artifacts — fix the data and re-run from the style page"
      >
        Blocked, fix &amp; re-run
      </Link>
    );
  }
  return (
    <Link
      href={`/styles/${t.styleId}/review`}
      className={buttonClass(t.decided > 0 ? "primary" : "secondary", "sm")}
    >
      {t.decided > 0 ? "Finish review" : startedContext ? "Continue review" : "Start review"}
    </Link>
  );
}

// Each style is an expandable row: the summary toggles its outputs; the action
// button and the per-output links navigate to the review page.
export function StyleTaskList({
  tasks,
  activityPrefix,
  // When these rows are reviews already started (the /reviews "In progress"
  // tab), a claimed-but-undecided style reads "Continue review", not "Start
  // review". Default false keeps the dashboard and the first-review queue as-is.
  startedContext = false,
  // Open rejection-log threads per style, shown as "N with the admin" /
  // "N to look at again". Omitted where the page doesn't load them.
  comments,
  // Name who decided so far (the "in review by others" list).
  showReviewers = false,
  // Inside a card that already draws the border (a queue group).
  bare = false,
}: {
  tasks: ReviewTask[];
  activityPrefix: string;
  startedContext?: boolean;
  comments?: StyleCommentCounts;
  showReviewers?: boolean;
  bare?: boolean;
}) {
  return (
    <ul
      className={`divide-line divide-y ${bare ? "" : "border-line bg-surface overflow-hidden rounded-xl border"}`}
    >
      {tasks.map((t) => {
        const c = comments?.[t.styleId];
        const all = t.decided + t.total;
        return (
          <li key={t.jobId}>
            <details className="group/task">
              <summary className="hover:bg-subtle flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 transition-colors duration-150 [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className="text-faint shrink-0 transition-transform group-open/task:rotate-90"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-ink truncate text-[13px] font-medium">{t.styleName}</span>
                    {t.businessArea ? <span className="text-muted text-[12px]">{t.businessArea}</span> : null}
                  </div>
                  <div className="text-muted truncate text-[12px]">
                    {t.customerName}
                    {t.poNumber ? ` · PO ${t.poNumber}` : ""} · {activityPrefix}
                    {timeAgo(t.lastActivityAt)}
                    {showReviewers ? (
                      <span data-private> · {t.reviewerEmails.join(", ") || "unknown reviewer"}</span>
                    ) : null}
                  </div>
                </div>
                <div className="hidden shrink-0 items-center gap-2 md:flex">
                  {c?.fixed ? (
                    <Pill tone="accent" title="Marked fixed by an admin, waiting for another look">
                      {c.fixed} to look at again
                    </Pill>
                  ) : null}
                  {c?.open ? (
                    <Pill tone="warn" title="Comments waiting for an admin to fix">
                      {c.open} with the admin
                    </Pill>
                  ) : null}
                  {t.decided > 0 ? (
                    <MiniProgress done={t.decided} total={all} label="decided" />
                  ) : t.total > 0 ? (
                    <span className="text-muted text-[12px] tabular-nums">{t.total} to review</span>
                  ) : null}
                </div>
                <StyleTaskAction t={t} startedContext={startedContext} />
              </summary>
              <div className="border-line bg-bg border-t px-4 py-3 pl-10">
                <ul className="flex flex-col gap-1.5">
                  {t.outputs.map((o) => {
                    const s = OUTPUT_STATE[o.state];
                    return (
                      <li key={o.variantKey} className="flex items-center justify-between gap-3 text-[12px]">
                        <span className={`min-w-0 truncate ${o.generated ? "text-ink" : "text-faint"}`}>{o.name}</span>
                        <span className="flex shrink-0 items-center gap-3">
                          <Pill tone={s.tone}>{s.label}</Pill>
                          {o.generated ? (
                            <Link
                              href={`/styles/${t.styleId}/review#${outputAnchor(o.variantKey)}`}
                              className="text-accent-text w-10 text-right hover:underline"
                            >
                              Open
                            </Link>
                          ) : o.state === "AWAITING_DATA" ? (
                            // Not generated — missing data. The review page lets
                            // a reviewer fill the fields in to generate it.
                            <Link href={`/styles/${t.styleId}/review`} className="text-warn w-10 text-right hover:underline">
                              Fix
                            </Link>
                          ) : (
                            // No document yet — keep the column aligned, no action.
                            <span className="text-faint w-10 text-right" aria-hidden="true">
                              —
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {/* The readiness notice folds the whole pipeline (PO/EANs →
                    spec → fields → generation → review) into one role-aware
                    ladder, collapsed to its pill here. */}
                <OutputReadinessNotice
                  notice={t.notice}
                  role="REVIEWER"
                  hrefs={readinessHrefs(t)}
                  collapsible
                  className="mt-3"
                />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

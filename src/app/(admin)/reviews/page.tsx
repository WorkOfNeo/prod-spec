import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { SIGN_IN_AGAIN } from "@/lib/auth-paths";
import { getReviewBoard } from "@/lib/dashboard/review-tasks";
import { getNeedsInputStyles } from "@/lib/dashboard/needs-input";
import { getApprovedStyles } from "@/lib/dashboard/approved-styles";
import { StyleTaskList } from "@/components/style-task-list";
import { ReviewGroupList } from "./review-group-list";
import { NeedsInputList } from "./needs-input-list";
import { ApprovedList } from "./approved-list";
import { loadStyleCommentCounts } from "@/lib/dashboard/style-comment-counts";
import { PageHeader } from "@/components/ui/page-header";
import { TabLinks, type TabLink } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClass } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// The review board — three tabs:
//  • "In Progress": every style whose review has been started (shared across
//    reviewers), shown with its latest output until it's fully approved — the
//    fix → regenerate → approve loop lives here.
//  • "Review": the untouched queue, grouped by prod spec (customer × business
//    area) so the work reads as categories (Netto · Private Label, …). Open a
//    group to see its styles and start a review.
//  • "Needs input": styles that can't generate yet — missing PO / barcodes /
//    Monday fields. They never get a job, so they'd otherwise be invisible to
//    reviewers; this surfaces them (no PDFs rendered) with the readiness ladder
//    so the missing data can be fixed.
// Visible to reviewers and admins alike — it sits under "My tasks" in the
// sidebar — so it gates on a session, not the admin role.
export const metadata = { title: "Reviews" };

type Tab = "in-progress" | "queue" | "needs-input" | "approved";

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect(SIGN_IN_AGAIN);

  // In Progress is the default landing tab (the live worklist); the others are
  // reached via ?tab=queue / ?tab=needs-input.
  const rawTab = (await searchParams).tab;
  const tab: Tab =
    rawTab === "queue"
      ? "queue"
      : rawTab === "needs-input"
        ? "needs-input"
        : rawTab === "approved"
          ? "approved"
          : "in-progress";

  // The tab bar needs every count, but only the active tab's cards render —
  // so the board builds cards for that tab alone (none on Needs input /
  // Approved).
  const [{ groups, inProgress, queueCount, inProgressCount }, needsInput, approved] =
    await Promise.all([
      getReviewBoard({
        cards: tab === "queue" ? ["queue"] : tab === "in-progress" ? ["inProgress"] : [],
      }),
      getNeedsInputStyles(),
      getApprovedStyles(),
    ]);
  // The readiness notice defaults to the REVIEWER lens; admins get the ADMIN
  // ladder (they own PO/scrape/SharePoint steps).
  const readinessRole = role === "ADMIN" ? "ADMIN" : "REVIEWER";
  // Open comment threads per style, on the tabs that list styles mid-review.
  const comments = await loadStyleCommentCounts(
    tab === "in-progress"
      ? inProgress.map((t) => t.styleId)
      : tab === "queue"
        ? groups.flatMap((g) => g.tasks.map((t) => t.styleId))
        : [],
  );

  const tabs: TabLink[] = [
    { key: "in-progress", label: "In progress", href: "/reviews", count: inProgressCount },
    { key: "queue", label: "Review", href: "/reviews?tab=queue", count: queueCount },
    { key: "needs-input", label: "Needs input", href: "/reviews?tab=needs-input", count: needsInput.length },
    // The done pile — progress you can SEE. Last: it's the outcome, not a worklist.
    { key: "approved", label: "Approved", href: "/reviews?tab=approved", count: approved.total },
  ];

  return (
    <div className="px-6 py-5">
      <PageHeader
        title="Reviews"
        meta={
          tab === "queue"
            ? "Styles waiting for their first review, grouped by prod spec: customer and business area."
            : tab === "needs-input"
              ? "Styles that can't generate yet: missing PO, barcodes or Monday fields. Once the data is there they generate and move to Review on their own."
              : tab === "approved"
                ? "Fully approved styles, newest first, and how far delivery got."
                : "Reviews already started. Comments go to the rejection log; fixed outputs come back here."
        }
        actions={
          // The numbers behind this board: throughput, step timings, first-pass
          // and turnaround rates. Reviewer-reachable, same as this page.
          <Link href="/reviews/dashboard" className={buttonClass("secondary")}>
            Review dashboard
          </Link>
        }
      />

      <TabLinks items={tabs} active={tab} label="Reviews" className="mt-4" />

      <div className="mt-4">
        {tab === "queue" ? (
          groups.length === 0 ? (
            <EmptyState
              title="Nothing waiting for a first review."
              body="When a job finishes rendering, its style appears here, grouped by prod spec."
            />
          ) : (
            <ReviewGroupList groups={groups} comments={comments} />
          )
        ) : tab === "needs-input" ? (
          needsInput.length === 0 ? (
            <EmptyState
              title="Nothing waiting on data."
              body="Styles missing a PO, barcodes or Monday fields show here so they can be fixed before they generate."
            />
          ) : (
            <NeedsInputList styles={needsInput} role={readinessRole} />
          )
        ) : tab === "approved" ? (
          approved.styles.length === 0 ? (
            <EmptyState
              title="Nothing fully approved yet."
              body="Styles land here once every output is approved, with their delivery status toward the supplier."
            />
          ) : (
            <ApprovedList styles={approved.styles} total={approved.total} />
          )
        ) : inProgress.length === 0 ? (
          <EmptyState
            title="No reviews in progress."
            body="Start a review from the Review tab and the style moves here until it's approved."
          >
            <Link href="/reviews?tab=queue" className={buttonClass("secondary", "sm")}>
              Review queue
            </Link>
          </EmptyState>
        ) : (
          <StyleTaskList tasks={inProgress} activityPrefix="updated " startedContext comments={comments} />
        )}
      </div>
    </div>
  );
}

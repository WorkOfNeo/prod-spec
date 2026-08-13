import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { getReviewBoard } from "@/lib/dashboard/review-tasks";
import { getNeedsInputStyles } from "@/lib/dashboard/needs-input";
import { getApprovedStyles } from "@/lib/dashboard/approved-styles";
import { StyleTaskList } from "@/components/style-task-list";
import { ReviewTabs } from "./review-tabs";
import { ReviewGroupList } from "./review-group-list";
import { NeedsInputList } from "./needs-input-list";
import { ApprovedList } from "./approved-list";

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
  if (!session) redirect("/login");

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

  const [{ groups, inProgress }, needsInput, approved] = await Promise.all([
    getReviewBoard(),
    getNeedsInputStyles(),
    getApprovedStyles(),
  ]);
  const queueCount = groups.reduce((n, g) => n + g.tasks.length, 0);
  // The readiness notice defaults to the REVIEWER lens; admins get the ADMIN
  // ladder (they own PO/scrape/SharePoint steps).
  const readinessRole = role === "ADMIN" ? "ADMIN" : "REVIEWER";

  return (
    <div className="px-8 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        {/* The numbers behind this board: throughput, step timings, first-pass
            and turnaround rates, filterable by client / supplier / reviewer.
            Reviewer-reachable, same as this page. */}
        <Link
          href="/reviews/dashboard"
          className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Review dashboard
        </Link>
      </div>
      <p className="text-sm text-zinc-500">
        {tab === "queue"
          ? "Styles awaiting their first review, grouped by prod spec — customer and business area. Open a group to review its styles."
          : tab === "needs-input"
            ? "Styles that can't generate yet — missing PO, barcodes or Monday fields. Fix the data and they generate and move to Review automatically. Nothing is rendered here."
            : tab === "approved"
              ? "Fully approved styles, newest first — and how far delivery got: queued, in the supplier's folder, or sent in a digest."
              : "Reviews already started — fix, regenerate and approve each style here. Only the latest output is shown."}
      </p>

      <ReviewTabs
        active={tab}
        queueCount={queueCount}
        inProgressCount={inProgress.length}
        needsInputCount={needsInput.length}
        approvedCount={approved.total}
      />

      {tab === "queue" ? (
        groups.length === 0 ? (
          <EmptyState
            title="Nothing waiting for a first review."
            body="When a job finishes rendering, its style appears here, grouped by prod spec."
          />
        ) : (
          <ReviewGroupList groups={groups} />
        )
      ) : tab === "needs-input" ? (
        needsInput.length === 0 ? (
          <EmptyState
            title="Nothing waiting on data."
            body="Styles missing a PO, barcodes or Monday fields show here so you can fix them before they generate."
          />
        ) : (
          <NeedsInputList styles={needsInput} role={readinessRole} />
        )
      ) : tab === "approved" ? (
        approved.styles.length === 0 ? (
          <EmptyState
            title="Nothing fully approved yet."
            body="Styles land here once every output is approved — with their delivery status toward the supplier."
          />
        ) : (
          <ApprovedList styles={approved.styles} total={approved.total} />
        )
      ) : inProgress.length === 0 ? (
        <EmptyState
          title="No reviews in progress."
          body="Start a review from the Review tab and the style moves here until it's approved."
        />
      ) : (
        <StyleTaskList tasks={inProgress} activityPrefix="updated " startedContext />
      )}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-8 text-center">
      <div className="text-sm font-semibold text-zinc-800">{title}</div>
      <p className="mt-1 text-sm text-zinc-500">{body}</p>
    </div>
  );
}

import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { getReviewBoard } from "@/lib/dashboard/review-tasks";
import { StyleTaskList } from "@/components/style-task-list";
import { ReviewTabs } from "./review-tabs";
import { ReviewGroupList } from "./review-group-list";

export const dynamic = "force-dynamic";

// The review board — two tabs over the styles awaiting review:
//  • "Review": the untouched queue, grouped by prod spec (customer × business
//    area) so the work reads as categories (Netto · Private Label, …). Open a
//    group to see its styles and start a review.
//  • "In Progress": every style whose review has been started (shared across
//    reviewers), shown with its latest output until it's fully approved — the
//    fix → regenerate → approve loop lives here.
// Visible to reviewers and admins alike — it sits under "My tasks" in the
// sidebar — so it gates on a session, not the admin role.
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { session } = await getSessionWithRole();
  if (!session) redirect("/login");

  const tab = (await searchParams).tab === "in-progress" ? "in-progress" : "queue";
  const { groups, inProgress } = await getReviewBoard();
  const queueCount = groups.reduce((n, g) => n + g.tasks.length, 0);

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
      <p className="text-sm text-zinc-500">
        {tab === "queue"
          ? "Styles awaiting their first review, grouped by prod spec — customer and business area. Open a group to review its styles."
          : "Reviews already started — fix, regenerate and approve each style here. Only the latest output is shown."}
      </p>

      <ReviewTabs active={tab} queueCount={queueCount} inProgressCount={inProgress.length} />

      {tab === "queue" ? (
        groups.length === 0 ? (
          <EmptyState
            title="Nothing waiting for a first review."
            body="When a job finishes rendering, its style appears here, grouped by prod spec."
          />
        ) : (
          <ReviewGroupList groups={groups} />
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

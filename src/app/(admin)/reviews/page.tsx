import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { getReviewQueue } from "@/lib/dashboard/review-tasks";
import { StyleTaskList } from "@/components/style-task-list";

export const dynamic = "force-dynamic";

// The review queue — every style currently awaiting review, grouped one card
// per style (the same "collected per style" unit as My tasks' "waiting for
// first review"). Un-bucketed: the whole queue, regardless of who has started
// it, in one place. Visible to reviewers and admins alike — it sits under
// "My tasks" in the sidebar — so it gates on a session, not the admin role.
export default async function ReviewsPage() {
  const { session } = await getSessionWithRole();
  if (!session) redirect("/login");

  const queue = await getReviewQueue();

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
      <p className="text-sm text-zinc-500">
        Every style awaiting review, grouped by style — longest-waiting first. Open one to decide
        its documents.
      </p>

      <p className="mt-4 text-xs text-zinc-500">
        {queue.length} {queue.length === 1 ? "style" : "styles"} awaiting review
      </p>

      {queue.length === 0 ? (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-8 text-center">
          <div className="text-sm font-semibold text-zinc-800">Nothing awaiting review.</div>
          <p className="mt-1 text-sm text-zinc-500">
            When a job finishes rendering, its style appears here for review.
          </p>
        </div>
      ) : (
        <StyleTaskList tasks={queue} activityPrefix="ready " />
      )}
    </div>
  );
}

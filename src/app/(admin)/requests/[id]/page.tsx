import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { SIGN_IN_AGAIN } from "@/lib/auth-paths";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { loadRequestView } from "@/lib/change-requests/review-view";
import { resumeAwaitingCode } from "@/lib/change-requests/gap";
import { startChangeRequestRun } from "@/lib/change-requests/agent/job";
import { RequestStatusPill } from "../status-pill";
import { RequestReview } from "./request-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Request" };

// =====================================================
// /requests/[id] — the review screen (design docs/plans/change-requests.md §6).
//
// One tab per output (issue). For each: what the requester asked, then what
// the agent did — the draft with before/after proofs, the impact list and the
// layout diff — the thread to ask for another draft, and Approve / Reject.
// Approving publishes the layout and reruns exactly the changed documents
// (publish.ts); nothing prints differently before that.
//
// Admin-only: anyone else is sent home. (review-view.ts still knows a
// read-only requester view, for when filing opens to reviewers.)
// Behind CHANGE_REQUESTS_ENABLED: with the flag off the page does not exist.
// =====================================================

export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ output?: string }>;
}) {
  if (!changeRequestsEnabled()) notFound();
  const { session, role } = await getSessionWithRole();
  if (!session) redirect(SIGN_IN_AGAIN);
  if (!isAdmin(role)) redirect("/");

  const { id } = await params;
  const sp = await searchParams;
  const viewer = { userId: session.user.id, role };
  let result = await loadRequestView(id, viewer);
  if (!result.ok) {
    if (result.reason === "not_found") notFound();
    redirect("/requests");
  }

  // Design §5.6: opening the request picks up an output that was waiting for
  // a new variable once the deploy that added it is live (the cron sweep does
  // the same every tick). Admins only; fail-soft; starts at most this
  // request's own outputs. When one starts, the view is read again so the page
  // shows it working — never a redirect back to this URL, which loops whenever
  // the output lands in NEEDS_CODE again ("too many redirects").
  const waiting = result.view.admin
    ? result.view.outputs.filter((o) => o.status === "NEEDS_CODE").map((o) => o.id)
    : [];
  if (waiting.length > 0) {
    const resumed = await resumeAwaitingCode(
      (outputId) => startChangeRequestRun(outputId, { trigger: "resume", userId: session.user.id }),
      { outputIds: waiting },
    ).catch(() => [] as string[]);
    if (resumed.length > 0) {
      const reloaded = await loadRequestView(id, viewer).catch(() => null);
      if (reloaded?.ok) result = reloaded;
    }
  }
  const view = result.view;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <Link href="/requests" className="text-sm text-muted hover:text-ink">
        ← Requests
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold tracking-[-0.01em]">
            <span className="font-mono text-faint">{view.ref}</span> {view.title}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <RequestStatusPill status={view.status} />
            <span>
              Filed by {view.requester} · {view.createdLabel}
            </span>
            {view.poNumber && !view.title.includes(view.poNumber) && <span>· PO {view.poNumber}</span>}
          </p>
        </div>
      </div>
      {view.message.trim() && (
        <details className="mt-3 max-w-3xl text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">The request as written</summary>
          <p className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-surface p-3 text-ink">
            {view.message}
          </p>
        </details>
      )}
      <div className="mt-6">
        <RequestReview view={view} initialOutputId={sp.output ?? null} />
      </div>
    </div>
  );
}

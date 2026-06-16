import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getReviewWork, timeAgo, type ReviewTask, type ReviewTaskOutput } from "@/lib/dashboard/review-tasks";
import { outputAnchor } from "@/lib/outputs/current-outputs";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { NotificationsFeed, type FeedRow } from "./notifications-feed";
import { RefreshOnFocus } from "./refresh-on-focus";

export const dynamic = "force-dynamic";

// My tasks — the per-user landing page. Answers "what is waiting on me?"
// the moment the app opens. Everything review-related is DERIVED from
// Job/JobAsset state (see lib/dashboard/review-tasks.ts): rows appear when
// a review is left unfinished — even via a killed tab — and vanish on their
// own the moment the job settles.
export default async function DashboardPage() {
  // Test-phase machinery — with the kill switch thrown the dashboard
  // doesn't exist; old links land on the styles list like before.
  if (!reviewFollowThroughEnabled()) redirect("/styles");

  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  const isAdmin = role === "ADMIN";

  const [work, openTickets, notifications] = await Promise.all([
    getReviewWork(session.user.id),
    db.rejectionTicket.count({
      where: { reportedById: session.user.id, status: { not: "RESOLVED" } },
    }),
    // Open feed only — dismissed rows are hidden by the user, resolved rows
    // point at work that already settled (stamped by the job settle paths).
    // Fail-soft: the user_notifications table ships with this release
    // (Railway runs `prisma migrate deploy` on start), so a dev DB that
    // hasn't migrated yet must degrade to an empty feed, not a 500.
    db.userNotification
      .findMany({
        where: { userId: session.user.id, dismissedAt: null, resolvedAt: null },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
      .catch(() => []),
  ]);

  const feedRows: FeedRow[] = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    href: n.href,
    createdAgo: timeAgo(n.createdAt),
    unread: n.readAt === null,
  }));

  const waitingOnYou = work.mine.length + work.untouched.length;
  const allQuiet = waitingOnYou === 0 && work.others.length === 0 && openTickets === 0;

  return (
    <div className="px-8 py-8">
      <RefreshOnFocus />
      <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
      <p className="text-sm text-zinc-500">
        {session.user.email}
        {" · "}
        {waitingOnYou === 0
          ? "nothing waiting on you"
          : `${waitingOnYou} thing${waitingOnYou === 1 ? "" : "s"} waiting on you`}
      </p>

      {allQuiet ? (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-8 text-center">
          <div className="text-sm font-semibold text-zinc-800">All caught up.</div>
          <p className="mt-1 text-sm text-zinc-500">
            No unfinished reviews, nothing waiting for a first review, no open rejections.
          </p>
          <div className="mt-4 flex justify-center gap-3 text-sm">
            <Link href="/styles" className="text-zinc-700 underline hover:text-zinc-900">
              Browse styles
            </Link>
            <Link href="/reviews" className="text-zinc-700 underline hover:text-zinc-900">
              All outputs
            </Link>
            <Link href="/jobs" className="text-zinc-700 underline hover:text-zinc-900">
              View jobs
            </Link>
          </div>
        </div>
      ) : (
        <>
          {work.mine.length > 0 && (
            <section className="mt-6">
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                <h2 className="text-sm font-semibold text-amber-900">
                  ⚠ Unfinished reviews — yours ({work.mine.length})
                </h2>
                <p className="mt-0.5 text-xs text-amber-800">
                  You decided some documents but not all.{" "}
                  <b>Nothing is sent to the supplier until every document is decided.</b>
                </p>
                <StyleTaskList tasks={work.mine} activityPrefix="" />
              </div>
            </section>
          )}

          {work.untouched.length > 0 && (
            <section className="mt-6">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-zinc-800">
                  Waiting for first review ({work.untouched.length})
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Documents finished rendering — nobody has started reviewing. Shown to everyone
                  until reviewer assignment exists.
                </p>
                <StyleTaskList tasks={work.untouched} activityPrefix="ready " />
              </div>
            </section>
          )}

          {work.others.length > 0 && (
            <section className="mt-6">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-zinc-500">
                  In review by others ({work.others.length})
                </h2>
                <p className="mt-0.5 text-xs text-zinc-400">
                  Partially decided by someone else — listed so a half-finished review can&rsquo;t
                  hide, muted because it isn&rsquo;t your to-do.
                </p>
                <ul className="mt-2 space-y-1">
                  {work.others.map((t) => (
                    <li key={t.jobId} className="text-xs text-zinc-500">
                      <Link
                        href={`/styles/${t.styleId}/review`}
                        className="font-medium text-zinc-600 hover:underline"
                      >
                        {t.styleName}
                      </Link>{" "}
                      · {t.customerName}
                      {t.poNumber ? <> · PO {t.poNumber}</> : null} · {t.decided}/{t.total} decided ·{" "}
                      {t.reviewerEmails.join(", ") || "unknown reviewer"} ·{" "}
                      {timeAgo(t.lastActivityAt)}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {openTickets > 0 && (
            <section className="mt-6">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-zinc-800">
                  Open rejections ({openTickets})
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Tickets you reported that aren&rsquo;t resolved — fixes land back here as a
                  re-review when the admin marks them fixed.
                  {/* The rejection log is the admin workbench — reviewers only
                      need the count; their re-reviews arrive via this page. */}
                  {isAdmin && (
                    <>
                      {" "}
                      <Link
                        href="/settings/rejection-log"
                        className="font-medium text-zinc-700 underline hover:text-zinc-900"
                      >
                        Open rejection log →
                      </Link>
                    </>
                  )}
                </p>
              </div>
            </section>
          )}
        </>
      )}

      <section className="mt-6">
        <NotificationsFeed rows={feedRows} />
      </section>

      <p className="mt-6 text-xs text-zinc-400">
        Unfinished reviews clear automatically the moment every document on the job is approved or
        rejected; notifications resolve themselves when the review they point at settles.
      </p>
    </div>
  );
}

const OUTPUT_CHIP: Record<ReviewTaskOutput["state"], { cls: string; label: string }> = {
  APPROVED: { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "approved" },
  REJECTED: { cls: "border-red-200 bg-red-50 text-red-700", label: "rejected" },
  BLOCKED: { cls: "border-amber-200 bg-amber-50 text-amber-800", label: "blocked" },
  TO_REVIEW: { cls: "border-blue-200 bg-blue-50 text-blue-700", label: "to review" },
};

function StyleTaskAction({ t }: { t: ReviewTask }) {
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
      {t.decided > 0 ? "Finish review" : "Start review"}
    </Link>
  );
}

// Each style is an expandable row: the summary toggles the accordion of its
// outputs; the action button and the per-output "Review" links navigate to
// the uniform review page (clicking those leaves the page, so the toggle is moot).
function StyleTaskList({ tasks, activityPrefix }: { tasks: ReviewTask[]; activityPrefix: string }) {
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
            <span className="hidden items-center gap-2 sm:inline-flex">
              <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-zinc-200">
                <span
                  className="block h-full rounded-full bg-amber-500"
                  style={{ width: `${t.total ? Math.round((t.decided / t.total) * 100) : 0}%` }}
                />
              </span>
              <span className="font-mono text-xs tabular-nums text-zinc-600">
                {t.decided}/{t.total}
              </span>
            </span>
            <StyleTaskAction t={t} />
          </summary>
          <div className="border-t border-zinc-100 px-3 py-2">
            <ul className="space-y-1">
              {t.outputs.map((o) => {
                const chip = OUTPUT_CHIP[o.state];
                return (
                  <li key={o.variantKey} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate text-zinc-700">{o.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chip.cls}`}>
                        {chip.label}
                      </span>
                      <Link
                        href={`/styles/${t.styleId}/review#${outputAnchor(o.variantKey)}`}
                        className="text-blue-700 hover:underline"
                      >
                        Review
                      </Link>
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

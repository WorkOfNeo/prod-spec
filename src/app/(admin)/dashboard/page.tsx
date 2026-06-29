import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getReviewWork, timeAgo } from "@/lib/dashboard/review-tasks";
import { StyleTaskList } from "@/components/style-task-list";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { NotificationsFeed, type FeedRow } from "./notifications-feed";
import { RefreshOnFocus } from "./refresh-on-focus";

export const dynamic = "force-dynamic";

// My tasks — the per-user landing page. Answers "what is waiting on me?"
// the moment the app opens. Everything review-related is DERIVED from
// Job/JobAsset state (see lib/dashboard/review-tasks.ts): rows appear when
// a review is left unfinished — even via a killed tab — and vanish on their
// own the moment the job settles.
export const metadata = { title: "Dashboard" };

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

  // Only reviews you've STARTED count as "waiting on you" — the untouched
  // first-review queue isn't yours until you pick it up (it lives on /reviews).
  const waitingOnYou = work.mine.length;
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
            No unfinished reviews, no open rejections. New work waiting for a first review lives on
            the Review queue.
          </p>
          <div className="mt-4 flex justify-center gap-3 text-sm">
            <Link href="/styles" className="text-zinc-700 underline hover:text-zinc-900">
              Browse styles
            </Link>
            <Link href="/reviews" className="text-zinc-700 underline hover:text-zinc-900">
              Review queue
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

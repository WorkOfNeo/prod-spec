import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { SIGN_IN_AGAIN } from "@/lib/auth-paths";
import { db } from "@/lib/db";
import { getReviewWork, timeAgo } from "@/lib/dashboard/review-tasks";
import { loadStyleCommentCounts } from "@/lib/dashboard/style-comment-counts";
import { outputAnchor } from "@/lib/outputs/current-outputs";
import { splitTicketComment } from "@/lib/tickets/thread";
import { StyleTaskList } from "@/components/style-task-list";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat";
import { Section } from "@/components/ui/section";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { buttonClass } from "@/components/ui/button";
import { NotificationsFeed, type FeedRow } from "./notifications-feed";
import { RefreshOnFocus } from "./refresh-on-focus";

export const dynamic = "force-dynamic";

// My tasks — the per-user landing page. Answers "what is waiting on me?"
// the moment the app opens. Everything review-related is DERIVED from
// Job/JobAsset state (see lib/dashboard/review-tasks.ts): rows appear when
// a review is left unfinished — even via a killed tab — and vanish on their
// own the moment the job settles. The comment loop comes from the rejection
// log: what an admin fixed comes back here, and what's still with the admin
// is listed so nothing you said goes quiet.
export const metadata = { title: "Dashboard" };

// The rows we list per comment bucket; the counts come from a separate,
// uncapped count.
const THREAD_LIMIT = 50;

export default async function DashboardPage() {
  // Test-phase machinery — with the kill switch thrown the dashboard
  // doesn't exist; old links land on the styles list like before.
  if (!reviewFollowThroughEnabled()) redirect("/styles");

  const { session, role } = await getSessionWithRole();
  if (!session) redirect(SIGN_IN_AGAIN);
  const isAdmin = role === "ADMIN";
  const me = session.user.id;

  const [work, threadCounts, threads, notifications] = await Promise.all([
    // Only the two buckets this page renders get cards built; the untouched
    // queue lives on /reviews.
    getReviewWork(me, { buckets: ["mine", "others"] }),
    db.rejectionTicket.groupBy({
      by: ["status"],
      where: { reportedById: me, status: { in: ["OPEN", "IN_PROGRESS", "FIXED"] } },
      _count: { _all: true },
    }),
    // Your comments that aren't settled: FIXED ones are back for your look,
    // OPEN / IN_PROGRESS ones are still with the admin.
    db.rejectionTicket.findMany({
      where: { reportedById: me, status: { in: ["OPEN", "IN_PROGRESS", "FIXED"] } },
      orderBy: { updatedAt: "desc" },
      take: THREAD_LIMIT * 2,
      select: {
        id: true,
        status: true,
        styleId: true,
        styleName: true,
        outputName: true,
        variantKey: true,
        poNumber: true,
        comment: true,
        createdAt: true,
        fixedAt: true,
      },
    }),
    // Open feed only — dismissed rows are hidden by the user, resolved rows
    // point at work that already settled (stamped by the job settle paths).
    // Fail-soft: the user_notifications table ships with this release
    // (Railway runs `prisma migrate deploy` on start), so a dev DB that
    // hasn't migrated yet must degrade to an empty feed, not a 500.
    db.userNotification
      .findMany({
        where: { userId: me, dismissedAt: null, resolvedAt: null },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
      .catch(() => []),
  ]);

  const comments = await loadStyleCommentCounts([
    ...work.mine.map((t) => t.styleId),
    ...work.others.map((t) => t.styleId),
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

  const count = (statuses: string[]) =>
    threadCounts.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
  const backCount = count(["FIXED"]);
  const withAdminCount = count(["OPEN", "IN_PROGRESS"]);
  const back = threads.filter((t) => t.status === "FIXED").slice(0, THREAD_LIMIT);
  const withAdmin = threads.filter((t) => t.status !== "FIXED").slice(0, THREAD_LIMIT);

  // Waiting on you = reviews you've STARTED and outputs fixed for your look.
  // The untouched first-review queue isn't yours until you pick it up (it
  // lives on /reviews).
  const waitingOnYou = work.mine.length + backCount;
  const allQuiet = waitingOnYou === 0 && work.others.length === 0 && withAdminCount === 0;

  const reviewHref = (t: { styleId: string; variantKey: string }) =>
    `/styles/${t.styleId}/review${t.variantKey ? `#${outputAnchor(t.variantKey)}` : ""}`;
  // The newest thing the reviewer said on a thread.
  const lastComment = (comment: string) => splitTicketComment(comment).at(-1)?.text ?? comment;

  return (
    <div className="px-6 py-5">
      <RefreshOnFocus />
      <PageHeader
        title="My tasks"
        meta={
          <>
            <span data-private>{session.user.email}</span>
            {" · "}
            {waitingOnYou === 0
              ? "nothing waiting on you"
              : `${waitingOnYou} thing${waitingOnYou === 1 ? "" : "s"} waiting on you`}
          </>
        }
        actions={
          <Link href="/reviews?tab=queue" className={buttonClass("secondary")}>
            Review queue
          </Link>
        }
      />

      <div className="stagger mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Back from a fix"
          value={backCount}
          hint="Fixed by an admin, waiting for your look"
          tone={backCount > 0 ? "attention" : "default"}
        />
        <StatTile label="Unfinished reviews" value={work.mine.length} hint="Started, not every document decided" />
        <StatTile label="With the admin" value={withAdminCount} hint="Your comments waiting for a fix" />
        <StatTile label="In review by others" value={work.others.length} hint="Partly decided by someone else" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          {allQuiet ? (
            <EmptyState
              title="All caught up."
              body="No unfinished reviews and no open comments. New work waiting for a first review is on the review queue."
            >
              <Link href="/reviews?tab=queue" className={buttonClass("secondary", "sm")}>
                Review queue
              </Link>
              <Link href="/styles" className={buttonClass("ghost", "sm")}>
                Browse styles
              </Link>
            </EmptyState>
          ) : null}

          {back.length > 0 ? (
            <Section
              title="Back from a fix"
              count={backCount}
              desc="An admin fixed what you commented on. Approve it, or comment again to send it back."
            >
              <ul className="border-line bg-surface divide-line divide-y overflow-hidden rounded-xl border">
                {back.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-ink truncate text-[13px] font-medium">
                        {t.outputName} <span className="text-muted font-normal">· {t.styleName}</span>
                      </div>
                      <div className="text-muted truncate text-[12px]">
                        {t.poNumber ? `PO ${t.poNumber} · ` : ""}fixed {timeAgo(t.fixedAt ?? t.createdAt)}
                      </div>
                      <p className="text-muted mt-1 line-clamp-2 text-[12px]">
                        You said: <span className="text-ink">&ldquo;{lastComment(t.comment)}&rdquo;</span>
                      </p>
                    </div>
                    <Link href={reviewHref(t)} className={buttonClass("primary", "sm")}>
                      Take a look
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {work.mine.length > 0 ? (
            <Section
              title="Unfinished reviews, yours"
              count={work.mine.length}
              desc="You decided some documents but not all. Nothing goes to the supplier until every document is decided."
            >
              <StyleTaskList tasks={work.mine} activityPrefix="" comments={comments} startedContext />
            </Section>
          ) : null}

          {withAdmin.length > 0 ? (
            <Section
              title="Your comments with the admin"
              count={withAdminCount}
              desc="You're told when each one is marked fixed, and it comes back here."
              action={
                // The rejection log is the admin workbench — reviewers only
                // need their own threads; re-reviews arrive via this page.
                isAdmin ? (
                  <Link href="/settings/rejection-log" className={buttonClass("ghost", "sm")}>
                    Rejection log
                  </Link>
                ) : null
              }
            >
              <ul className="border-line bg-surface divide-line divide-y overflow-hidden rounded-xl border">
                {withAdmin.map((t) => (
                  <li key={t.id}>
                    <Link href={reviewHref(t)} className="hover:bg-subtle flex items-start gap-3 px-3 py-2.5 transition-colors duration-150">
                      <div className="min-w-0 flex-1">
                        <div className="text-ink truncate text-[13px] font-medium">
                          {t.outputName} <span className="text-muted font-normal">· {t.styleName}</span>
                        </div>
                        <p className="text-muted mt-0.5 line-clamp-2 text-[12px]">
                          &ldquo;{lastComment(t.comment)}&rdquo; · {timeAgo(t.createdAt)}
                        </p>
                      </div>
                      <Pill tone={t.status === "IN_PROGRESS" ? "accent" : "warn"} dot>
                        {t.status === "IN_PROGRESS" ? "Being fixed" : "Waiting for a fix"}
                      </Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {work.others.length > 0 ? (
            <Section
              title="In review by others"
              count={work.others.length}
              desc="Partly decided by someone else, listed so a half-finished review can't hide."
            >
              <StyleTaskList tasks={work.others} activityPrefix="" comments={comments} showReviewers />
            </Section>
          ) : null}
        </div>

        <aside className="min-w-0">
          <NotificationsFeed rows={feedRows} />
          <p className="text-faint mt-3 text-[12px] leading-relaxed">
            Unfinished reviews clear the moment every document is approved or rejected; notifications resolve
            themselves when the review they point at settles.
          </p>
        </aside>
      </div>
    </div>
  );
}

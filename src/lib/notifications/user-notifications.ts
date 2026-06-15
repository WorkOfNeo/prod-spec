import { db } from "@/lib/db";
import type { UserNotificationType } from "@/generated/prisma/enums";

// Per-user in-app notifications (the /dashboard feed). Producers mirror
// outbound emails; see prisma/schema.prisma (UserNotification) for the
// model contract. Every helper here is fail-soft: a notification is a
// nice-to-have layered on flows that must not break (publish, ticket fix,
// the runner), so failures log a warning and return instead of throwing.

type NotificationData = {
  type: UserNotificationType;
  title: string;
  body?: string;
  href?: string;
  jobId?: string;
  styleId?: string;
  ticketId?: string;
};

export async function notifyUser(userId: string, data: NotificationData): Promise<void> {
  try {
    await db.userNotification.create({ data: { userId, ...data } });
  } catch (err) {
    console.warn(`[notifications] failed to create for user ${userId}: ${(err as Error).message}`);
  }
}

// Reviewer inbox fan-out for "documents ready for review" (T2): every
// reviewer/admin gets the in-app entry so the inbox is the shared source of
// truth for who can pick up a review — matching the dashboard's global queue
// ("shown to everyone until reviewer assignment exists"). Any configured
// notification address that maps to an account is unioned in too, so a
// non-reviewer recipient still sees it. Deduped by user; fail-soft like the
// rest — a missing inbox row must never break the runner.
export async function notifyReviewers(emails: string[], data: NotificationData): Promise<number> {
  try {
    const users = await db.user.findMany({
      where: {
        OR: [
          { role: { in: ["ADMIN", "REVIEWER"] } },
          ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
        ],
      },
      select: { id: true },
    });
    if (users.length === 0) return 0;
    await db.userNotification.createMany({
      data: users.map((u) => ({ userId: u.id, ...data })),
    });
    return users.length;
  } catch (err) {
    console.warn(`[notifications] failed to notify reviewers: ${(err as Error).message}`);
    return 0;
  }
}

// Settle-time auto-resolve: when a job leaves AWAITING_REVIEW (published or
// rolled up to REJECTED), stamp every user's open notifications pointing at
// it — a finished review must not keep summoning reviewers.
export async function resolveNotificationsForJob(jobId: string): Promise<void> {
  try {
    await db.userNotification.updateMany({
      where: { jobId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  } catch (err) {
    console.warn(`[notifications] failed to resolve for job ${jobId}: ${(err as Error).message}`);
  }
}

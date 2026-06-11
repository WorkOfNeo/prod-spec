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

// The review-notification recipients are plain email strings from Settings —
// not user ids. Mirror to the matching accounts and silently skip addresses
// without one (e.g. a shared inbox): the email still goes out, there is
// just no in-app trace for a non-user.
export async function notifyUsersByEmail(emails: string[], data: NotificationData): Promise<number> {
  if (emails.length === 0) return 0;
  try {
    const users = await db.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    if (users.length === 0) return 0;
    await db.userNotification.createMany({
      data: users.map((u) => ({ userId: u.id, ...data })),
    });
    return users.length;
  } catch (err) {
    console.warn(`[notifications] failed to mirror to ${emails.length} email(s): ${(err as Error).message}`);
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

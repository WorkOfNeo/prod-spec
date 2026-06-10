import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  getStoredReviewNotificationEmails,
  setReviewNotificationEmails,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ emails: (await getStoredReviewNotificationEmails()).join(", ") });
}

// Set the internal recipient(s) of the post-generation notifications
// ("ready for review" + "fixed — ready for re-review"), comma-separated.
// ADMIN only. Clearing falls back to REVIEW_NOTIFICATION_EMAIL (env).
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const emails = (body as { emails?: unknown })?.emails;
  if (typeof emails !== "string") {
    return NextResponse.json({ error: "Body must be { emails: string }" }, { status: 400 });
  }

  await setReviewNotificationEmails(emails);
  const normalised = (await getStoredReviewNotificationEmails()).join(", ");
  await db.log.create({
    data: {
      level: "INFO",
      message: `review notification email set to "${normalised || "(cleared)"}" by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, emails: normalised });
}

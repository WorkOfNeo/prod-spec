import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  getSupplierReviewCcEmails,
  setSupplierReviewCcEmails,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ emails: (await getSupplierReviewCcEmails()).join(", ") });
}

// Set the actual email address(es) CC'd on supplier "ready for review"
// approval emails (comma-separated). ADMIN only.
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

  await setSupplierReviewCcEmails(emails);
  const normalised = (await getSupplierReviewCcEmails()).join(", ");
  await db.log.create({
    data: {
      level: "INFO",
      message: `supplier review CC set to "${normalised || "(cleared)"}" by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, emails: normalised });
}

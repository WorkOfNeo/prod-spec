import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Resend delivery webhook — records delivered/opened/clicked/bounced events so
// /settings/approved can show whether a supplier opened the nightly digest.
//
// Auth: Resend signs with Svix, but to avoid a new dependency we gate on a
// shared secret in the query string (?secret=$RESEND_WEBHOOK_SECRET), matching
// the cron routes' convention. If RESEND_WEBHOOK_SECRET is unset the endpoint
// accepts unauthenticated posts (dev) — set it in prod. Worst case of a spoof
// is a bogus "opened" row, never a send.
type ResendEvent = {
  type?: string; // e.g. "email.opened"
  created_at?: string;
  data?: { email_id?: string; created_at?: string };
};

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const provided =
      req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: ResendEvent;
  try {
    body = (await req.json()) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const providerId = body.data?.email_id;
  const rawType = body.type ?? "";
  if (!providerId || !rawType) {
    return NextResponse.json({ ok: true, skipped: "no email_id/type" });
  }
  const type = rawType.replace(/^email\./, ""); // "email.opened" → "opened"
  const occurredAt = body.created_at ? new Date(body.created_at) : new Date();

  // Resolve the EmailLog (loose ref) so the UI can join without a second query.
  const log = await db.emailLog.findFirst({
    where: { providerId },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });

  await db.emailEvent.create({
    data: { providerId, emailLogId: log?.id ?? null, type, occurredAt },
  });

  return NextResponse.json({ ok: true, matched: Boolean(log) });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST Resend events here (configure in Resend dashboard)." });
}

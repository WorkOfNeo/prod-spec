import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { getTrimsOnCoverEnabled, setTrimsOnCoverEnabled } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// The master switch for trims on cover pages.
//
// ADMIN only, unlike the cover-page prose and the trim vocabulary next door.
// Those change words on a page and are reviewer knowledge; this changes what
// every cover in the book says to every supplier at once, which is a release
// decision rather than an editorial one.
//
//   GET   /api/admin/settings/cover-page/trims-switch            -> { enabled }
//   PATCH /api/admin/settings/cover-page/trims-switch { enabled }

export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ enabled: await getTrimsOnCoverEnabled() });
}

const BODY = z.object({ enabled: z.boolean() });

export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { enabled: boolean }" }, { status: 400 });
  }

  await setTrimsOnCoverEnabled(parsed.data.enabled);
  return NextResponse.json({ enabled: parsed.data.enabled });
}

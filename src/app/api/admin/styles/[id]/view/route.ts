import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// View beacon — logs ONE StyleView row per page open (the client beacon fires
// once on mount). surface distinguishes the review screen from the style detail
// page. Best-effort by design: the insert is wrapped so a not-yet-deployed
// style_views table (or any transient DB hiccup) can never break a page the
// reviewer is just trying to read. Both ADMIN and REVIEWER open styles.
const SCHEMA = z.object({
  surface: z.enum(["REVIEW", "STYLE"]),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    await db.styleView.create({
      data: { styleId: id, userId: auth.userId, surface: parsed.data.surface },
    });
    return NextResponse.json({ ok: true });
  } catch {
    // Table not deployed yet, or the style was removed mid-view — a logging
    // beacon must never surface an error to the page. Swallow + 200.
    return NextResponse.json({ ok: true, logged: false });
  }
}

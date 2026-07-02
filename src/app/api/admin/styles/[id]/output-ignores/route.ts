import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";

export const runtime = "nodejs";

// Undo a per-style output ignore: DELETE ?variantKey=<base key>. The output
// re-enters the normal flow — any existing asset resurfaces on the review
// page (it stayed PENDING while ignored), and un-generated outputs become
// eligible for auto-generation again.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const variantKey = new URL(req.url).searchParams.get("variantKey")?.trim();
  if (!variantKey) {
    return NextResponse.json({ error: "variantKey query parameter is required" }, { status: 400 });
  }

  let removed = 0;
  try {
    removed = (
      await db.styleOutputIgnore.deleteMany({ where: { styleId: id, variantKey } })
    ).count;
  } catch {
    return NextResponse.json(
      { error: "Ignores aren't available yet — the style_output_ignores migration hasn't been deployed (db:deploy)." },
      { status: 503 },
    );
  }

  if (removed > 0) {
    await db.log.create({
      data: {
        level: "INFO",
        message: `output ${variantKey} un-ignored for style ${id} by ${session.user.email} — back in the normal generation/review flow`,
      },
    });
  }

  return NextResponse.json({ ok: true, removed });
}

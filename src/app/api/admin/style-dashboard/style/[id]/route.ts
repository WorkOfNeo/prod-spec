import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { getStyleOutputDetail } from "@/lib/dashboard/style-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-style output detail, fetched lazily when a style row is expanded on the
// Style Dashboard: every current output (incl. declared-but-not-yet-generated)
// with its name, SharePoint link, uploaded? and emailed? state.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const outputs = await getStyleOutputDetail(id);
  return NextResponse.json({ outputs });
}

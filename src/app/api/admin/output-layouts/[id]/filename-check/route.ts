import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { analyseStyleFilenames } from "@/lib/output-layouts/filename-collisions";

export const runtime = "nodejs";

// Admin-only: re-resolve ONE style against ONE layout's CURRENT file-name
// expression and report which documents still collide. Read-only — renders
// nothing and writes nothing, so it is safe to hit repeatedly while editing a
// template to check whether the fix took.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  const styleId = req.nextUrl.searchParams.get("styleId");
  if (!styleId) return NextResponse.json({ error: "styleId is required" }, { status: 400 });

  const analysis = await analyseStyleFilenames(styleId, id);
  return NextResponse.json({ ok: true, analysis });
}

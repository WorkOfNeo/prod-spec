import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { renderLayoutHtml } from "@/lib/output-layouts/render";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";

export const runtime = "nodejs";

// Static thumbnail for the /output-builder list. Renders the layout's FIRST
// page against the recognisable sample StyleData (buildSampleStyleData — the
// same object the gallery previews use), in production mode so the thumbnail
// reads like a real print rather than the builder's amber-chip view.
//
// GET → text/html (fed straight into a scaled PreviewFrame client-side).
// The list appends `?v=<updatedAtMs>` so an edit busts the cached image.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const layout = await db.outputLayout.findUnique({
    where: { id },
    select: { definition: true, customLogo: true },
  });
  if (!layout) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let def;
  try {
    def = parseLayoutDef(layout.definition);
  } catch {
    return NextResponse.json({ error: "Invalid layout definition" }, { status: 422 });
  }
  if (def.pages.length === 0) {
    return NextResponse.json({ error: "Layout has no pages" }, { status: 422 });
  }

  const html = await renderLayoutHtml(def, buildSampleStyleData(), {
    mode: "production",
    pageIndex: 0,
    customLogo: layout.customLogo,
    title: "Layout thumbnail",
  });

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Keyed by ?v=<updatedAt> — an edit changes the URL, so cache long.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

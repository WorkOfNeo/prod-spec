import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { renderCoverPageHtml } from "@/lib/pdf/bundle-pages";
import { inlineProdSpecImages } from "@/lib/pdf/inline-images";
import { loadStyleCoverInput } from "@/lib/pdf/style-cover";

export const runtime = "nodejs";

// Live cover preview for ONE style — the cover document as it would render
// right now: the style's own identity, its packaging rows with today's
// approval state, the global cover block and its spec's general information.
// The style-level twin of the prod spec editor's cover-preview (which wears
// sample identity), and of output-preview for a configured output: the change
// request form shows it as the cover's thumbnail.
//
//   GET /api/admin/styles/<id>/cover-preview
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  try {
    const cover = await loadStyleCoverInput(id);
    if (!cover) return NextResponse.json({ error: "Style not found" }, { status: 404 });

    let html = renderCoverPageHtml(cover.input);
    // General-info images inline the way the runner does; the cover block's
    // <img> serve URLs resolve live in the iframe (same origin, signed in).
    if (cover.prodSpecId && cover.input.generalInfo) html = await inlineProdSpecImages(html, cover.prodSpecId);

    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Render failed" }, { status: 500 });
  }
}

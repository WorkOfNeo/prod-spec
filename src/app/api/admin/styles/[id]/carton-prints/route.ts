import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { renderCartonCustomization } from "@/lib/output-layouts/carton-render";

export const runtime = "nodejs";
// One Chromium render of an N-page document; N can be large (cap in the helper).
export const maxDuration = 300;

// Manual carton prints are a SIDE action — standard generation is untouched
// (always single-style). This renders the chosen Output Builder layout once per
// carton (1…total) into ONE multi-page PDF the operator prints, OR a single
// page with other same-PO styles on the box. The render lives in
// renderCartonCustomization (shared with /carton-customize, which persists the
// result into review instead of downloading). Nothing is persisted here — the
// file streams straight back as a download.
//
//   POST /api/admin/styles/<id>/carton-prints
//   body: { variantKey: "layout:<id>", total: number, siblingIds?: string[] }
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  let variantKey = "";
  let total = 0;
  let siblingIds: string[] | null = null;
  try {
    const body = (await req.json()) as {
      variantKey?: unknown;
      total?: unknown;
      siblingIds?: unknown;
    };
    if (typeof body?.variantKey === "string") variantKey = body.variantKey;
    if (typeof body?.total === "number") total = body.total;
    if (Array.isArray(body?.siblingIds)) {
      siblingIds = body.siblingIds.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  try {
    const result = await renderCartonCustomization(id, { variantKey, total, siblingIds });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return new NextResponse(new Uint8Array(result.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 500 },
    );
  }
}

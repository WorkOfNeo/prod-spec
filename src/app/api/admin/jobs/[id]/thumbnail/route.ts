import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { renderPdfThumbnail } from "@/lib/pdf/thumbnail";

export const runtime = "nodejs";

// PNG thumbnail (page 1) of one generated asset — the realistic preview on
// the style detail Outputs list.
//
//   GET /api/admin/jobs/{jobId}/thumbnail?variantKey=care-label-01&v=<assetId>
//
// Cached per ASSET VERSION (id + updatedAt), not per (jobId, variantKey): a job
// retry deletes and recreates its assets under the same job, and a cover is
// rebuilt in place under the SAME id whenever its manifest moves (an output or
// a manual packaging line approved). Keying on the id alone kept serving the
// old cover's picture after such a rebuild. `v` isn't read here — the page
// embeds the same version purely so the browser's cache key changes when the
// bytes do, which is what lets us send a long max-age below.
const pngCache = new Map<string, Buffer>();
const CACHE_MAX = 200;
const WIDTH_PX = 720;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const variantKey = req.nextUrl.searchParams.get("variantKey");
  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });

  // Metadata-only lookup first — on a warm cache we never pull the 50-200 KB
  // PDF bytes across the wire at all.
  const asset = await db.jobAsset.findFirst({
    where: { jobId: id, variantKey },
    select: { id: true, updatedAt: true },
  });
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const cacheKey = `${asset.id}@${asset.updatedAt.getTime()}`;
  let png = pngCache.get(cacheKey);
  if (!png) {
    const withBytes = await db.jobAsset.findUnique({
      where: { id: asset.id },
      select: { pdf: true },
    });
    if (!withBytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

    try {
      png = await renderPdfThumbnail(new Uint8Array(withBytes.pdf), WIDTH_PX);
    } catch {
      return NextResponse.json({ error: "Could not render preview" }, { status: 422 });
    }

    if (pngCache.size >= CACHE_MAX) {
      const oldest = pngCache.keys().next().value;
      if (oldest) pngCache.delete(oldest);
    }
    pngCache.set(cacheKey, png);
  }

  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
    },
  });
}

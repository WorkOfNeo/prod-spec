import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { shareCookieName, verifyShareAccess } from "@/lib/supplier-share/share";

export const runtime = "nodejs";

// Public PDF bytes for a supplier share, gated by the unlock cookie set by
// /api/s/[token]/unlock. Only serves APPROVED assets that belong to the
// share's own job — a supplier can never reach another job's documents.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string; assetId: string }> },
) {
  const { token, assetId } = await ctx.params;

  const cookieStore = await cookies();
  const cookie = cookieStore.get(shareCookieName(token))?.value;
  if (!verifyShareAccess(token, cookie)) {
    return NextResponse.json({ error: "Locked" }, { status: 401 });
  }

  const share = await db.supplierShare.findUnique({
    where: { token },
    select: { jobId: true },
  });
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const asset = await db.jobAsset.findFirst({
    where: { id: assetId, jobId: share.jobId, reviewStatus: "APPROVED" },
    select: { pdf: true, fileName: true },
  });
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(asset.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${asset.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

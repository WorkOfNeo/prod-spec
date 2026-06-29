import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession, requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// Stream / delete a single stored General-information image. The serve route
// powers the editor's "Images" tab thumbnails (browser, admin session). The
// generated PDF never hits it — the renderer inlines the bytes to a data URL
// instead (src/lib/prod-spec/general-images.ts).
//
//   GET    /api/admin/prod-specs/<id>/images/<imageId>   → image bytes
//   DELETE /api/admin/prod-specs/<id>/images/<imageId>   → { ok }
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; imageId: string }> },
) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id, imageId } = await ctx.params;
  const image = await db.prodSpecImage.findFirst({
    where: { id: imageId, prodSpecId: id },
    select: { data: true, mimeType: true },
  });
  if (!image) return NextResponse.json({ error: "Image not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(image.data), {
    status: 200,
    headers: {
      "Content-Type": image.mimeType,
      // id-addressed and immutable — safe to cache hard. Private: it sits
      // behind the admin session.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; imageId: string }> },
) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id, imageId } = await ctx.params;
  // Scoped to the prod spec so a mismatched id can't delete another spec's
  // image; deleteMany is a no-op (count 0) if it's already gone.
  const res = await db.prodSpecImage.deleteMany({ where: { id: imageId, prodSpecId: id } });
  return NextResponse.json({ ok: true, deleted: res.count });
}

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";

// Stream a stored global cover-page image inline. Powers the markdown editor's
// <img> (visual mode) and the A4 preview iframe — both run in the browser, where
// this same-origin URL resolves under the admin session. The generated PDF never
// hits this route: the renderer inlines the bytes to a data URL instead
// (src/lib/pdf/inline-cover-images.ts).
//
//   GET /api/admin/settings/cover-page/images/<imageId>
export async function GET(_req: NextRequest, ctx: { params: Promise<{ imageId: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { imageId } = await ctx.params;
  const image = await db.coverPageImage.findUnique({
    where: { id: imageId },
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

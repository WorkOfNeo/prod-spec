import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  decodeImageDataUrl,
  sanitizeImageName,
  MAX_IMAGE_DATA_URL_CHARS,
} from "@/lib/images/decode-data-url";

export const runtime = "nodejs";

// Upload an image for the ProdSpec "General information" page. Bytes are stored
// in prod_spec_images (same pattern as job_assets.pdf) — NOT inlined into the
// markdown, which keeps only the short serve URL this route returns. The PDF
// renderer re-inlines the bytes to a data URL at render time
// (src/lib/pdf/inline-images.ts), because page.setContent() has no base URL.
//
//   POST /api/admin/prod-specs/<id>/images   { dataUrl, fileName? }
//   → { id, url }

const BODY_SCHEMA = z.object({
  dataUrl: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS, "image too large — keep it under ~5 MB"),
  fileName: z.string().max(255).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  const decoded = decodeImageDataUrl(parsed.data.dataUrl);
  if (!decoded.ok) return NextResponse.json({ error: decoded.error }, { status: 400 });

  // Confirm the ProdSpec exists so we 404 cleanly instead of an FK error.
  const prodSpec = await db.prodSpec.findUnique({ where: { id }, select: { id: true } });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  const image = await db.prodSpecImage.create({
    data: {
      prodSpecId: id,
      data: decoded.image.data,
      mimeType: decoded.image.mimeType,
      fileName: sanitizeImageName(parsed.data.fileName) ?? `image.${decoded.image.ext}`,
      byteSize: decoded.image.byteSize,
    },
    select: { id: true },
  });

  return NextResponse.json({
    id: image.id,
    url: `/api/admin/prod-specs/${id}/images/${image.id}`,
  });
}

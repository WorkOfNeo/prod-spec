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

// Ordered image collection for the ProdSpec "General information" page. Bytes
// live in prod_spec_images (same pattern as job_assets.pdf). Managed from the
// editor's "Images" tab (drag-and-drop); the images render stacked, one after
// another, after the general-info text on the General page (the renderer inlines
// each to a data URL — src/lib/prod-spec/general-images.ts).
//
//   GET    /api/admin/prod-specs/<id>/images           → { images: [...] }   (ordered)
//   POST   /api/admin/prod-specs/<id>/images  { dataUrl, fileName? }  → { id, url }
//   PATCH  /api/admin/prod-specs/<id>/images  { order: id[] }         → { ok }   (reorder)

const POST_SCHEMA = z.object({
  dataUrl: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS, "image too large — keep it under ~5 MB"),
  fileName: z.string().max(255).optional(),
});

const PATCH_SCHEMA = z.object({
  order: z.array(z.string().min(1)).max(500),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const images = await db.prodSpecImage.findMany({
    where: { prodSpecId: id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, fileName: true, mimeType: true, byteSize: true, sortOrder: true },
  });

  return NextResponse.json({
    images: images.map((img) => ({
      ...img,
      url: `/api/admin/prod-specs/${id}/images/${img.id}`,
    })),
  });
}

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
  const parsed = POST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  const decoded = decodeImageDataUrl(parsed.data.dataUrl);
  if (!decoded.ok) return NextResponse.json({ error: decoded.error }, { status: 400 });

  // Confirm the ProdSpec exists so we 404 cleanly instead of an FK error.
  const prodSpec = await db.prodSpec.findUnique({ where: { id }, select: { id: true } });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  // Append to the end of the collection.
  const agg = await db.prodSpecImage.aggregate({
    where: { prodSpecId: id },
    _max: { sortOrder: true },
  });
  const sortOrder = (agg._max.sortOrder ?? -1) + 1;

  const image = await db.prodSpecImage.create({
    data: {
      prodSpecId: id,
      data: decoded.image.data,
      mimeType: decoded.image.mimeType,
      fileName: sanitizeImageName(parsed.data.fileName) ?? `image.${decoded.image.ext}`,
      byteSize: decoded.image.byteSize,
      sortOrder,
    },
    select: { id: true, fileName: true, mimeType: true, byteSize: true, sortOrder: true },
  });

  return NextResponse.json({
    ...image,
    url: `/api/admin/prod-specs/${id}/images/${image.id}`,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  // Rewrite sortOrder to match the supplied order. updateMany scoped to this
  // prod spec ignores any id that isn't ours, so a stale/foreign id is a no-op.
  await db.$transaction(
    parsed.data.order.map((imageId, i) =>
      db.prodSpecImage.updateMany({
        where: { id: imageId, prodSpecId: id },
        data: { sortOrder: i },
      }),
    ),
  );

  return NextResponse.json({ ok: true });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// Upload an image for the ProdSpec "General information" page. Bytes are stored
// in prod_spec_images (same pattern as job_assets.pdf) — NOT inlined into the
// markdown, which keeps only the short serve URL this route returns. The PDF
// renderer re-inlines the bytes to a data URL at render time
// (src/lib/pdf/inline-images.ts), because page.setContent() has no base URL.
//
//   POST /api/admin/prod-specs/<id>/images   { dataUrl, fileName? }
//   → { id, url }

// Accepted image types — what marked → Puppeteer can embed and the editor
// offers via accept="image/*". The client sends a FileReader data URL.
const DATA_URL_RE =
  /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;

// ~5 MB decoded ceiling. base64 inflates by ~4/3, so reject the encoded string
// before decoding when it's already past that size (+ a little slack).
const MAX_BYTES = 5_000_000;
const MAX_DATA_URL_CHARS = Math.ceil((MAX_BYTES * 4) / 3) + 1024;

const BODY_SCHEMA = z.object({
  dataUrl: z.string().min(1).max(MAX_DATA_URL_CHARS, "image too large — keep it under ~5 MB"),
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

  const match = DATA_URL_RE.exec(parsed.data.dataUrl.trim());
  if (!match) {
    return NextResponse.json(
      { error: "Expected a base64 image data URL (PNG, JPEG, WebP, GIF or SVG)" },
      { status: 400 },
    );
  }
  const mimeType = match[1];
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "Empty image" }, { status: 400 });
  }
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "Image too large — keep it under ~5 MB" }, { status: 400 });
  }

  // Confirm the ProdSpec exists so we 404 cleanly instead of an FK error.
  const prodSpec = await db.prodSpec.findUnique({ where: { id }, select: { id: true } });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  const image = await db.prodSpecImage.create({
    data: {
      prodSpecId: id,
      data: bytes,
      mimeType,
      fileName: sanitizeName(parsed.data.fileName) ?? `image.${extFor(mimeType)}`,
      byteSize: bytes.byteLength,
    },
    select: { id: true },
  });

  return NextResponse.json({
    id: image.id,
    url: `/api/admin/prod-specs/${id}/images/${image.id}`,
  });
}

function extFor(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}

function sanitizeName(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = name.trim().replace(/[^\w.\- ]+/g, "_").slice(0, 255);
  return cleaned.length > 0 ? cleaned : null;
}

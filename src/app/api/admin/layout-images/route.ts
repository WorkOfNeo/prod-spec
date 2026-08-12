import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateLayoutImageCache } from "@/lib/output-layouts/images";
import { IMAGE_SLUG_RE } from "@/lib/output-layouts/image-slug";

export const runtime = "nodejs";

// The {{image:<slug>}} library — shared artwork any layout can place, any
// number of times. Mirrors /api/admin/certificates.

const BODY_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  // The token argument. Enforced here as well as in the UI because the slug
  // is the contract with every published layout that places the picture.
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(IMAGE_SLUG_RE, "use lowercase letters, digits and hyphens, e.g. coop-hanger"),
  // Raw SVG markup OR a data URL (PNG/JPG/SVG base64). 1 MB cap — same
  // convention and ceiling as Certificate.logo.
  image: z.string().max(1_000_000).optional().nullable(),
  active: z.boolean().optional(),
});

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const images = await db.layoutImage.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ images });
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await db.layoutImage.findUnique({ where: { slug: parsed.data.slug } });
  if (existing) {
    return NextResponse.json(
      { error: `The name "${parsed.data.slug}" is already taken by "${existing.name}"` },
      { status: 409 },
    );
  }

  const image = await db.layoutImage.create({
    data: {
      name: parsed.data.name,
      slug: parsed.data.slug,
      image: parsed.data.image ?? null,
      active: parsed.data.active ?? true,
    },
  });
  invalidateLayoutImageCache();
  return NextResponse.json({ image });
}

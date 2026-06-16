import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { refreshLayoutVariants } from "@/lib/output-layouts/variants";

export const runtime = "nodejs";

// Per-layout custom logo for {{logo:custom}}. Stored on OutputLayout.customLogo
// as a data URL — one logo per layout (replaces the old global logo). POST
// sets it, DELETE clears it. The print width is a % of the block, configured
// in the layout's settings (customLogoWidthPct); height auto-scales.

const BODY_SCHEMA = z.object({
  // SVG / PNG / JPEG data URL, capped at ~600 KB of encoded payload so a
  // stray photo doesn't bloat every render.
  dataUrl: z
    .string()
    .regex(/^data:image\/(svg\+xml|png|jpeg);base64,/, "must be an SVG, PNG or JPEG data URL")
    .max(600_000, "logo too large — keep it under ~450 KB"),
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

  try {
    const layout = await db.outputLayout.update({
      where: { id },
      data: { customLogo: parsed.data.dataUrl },
      select: { status: true },
    });
    // Published layouts render live — refresh the in-process variant so the
    // new logo shows on the next render without a republish.
    if (layout.status === "PUBLISHED") await refreshLayoutVariants();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  try {
    const layout = await db.outputLayout.update({
      where: { id },
      data: { customLogo: null },
      select: { status: true },
    });
    if (layout.status === "PUBLISHED") await refreshLayoutVariants();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

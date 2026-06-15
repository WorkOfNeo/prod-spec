import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(120).optional(),
  // Fractional mm allowed (e.g. 27.5) — see route.ts.
  widthMm: z.number().positive().max(1000).optional(),
  heightMm: z.number().positive().max(1000).optional(),
  active: z.boolean().optional(),
});

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
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const size = await db.infoAreaSize.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.widthMm !== undefined ? { widthMm: parsed.data.widthMm } : {}),
        ...(parsed.data.heightMm !== undefined ? { heightMm: parsed.data.heightMm } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      },
    });
    return NextResponse.json({ size });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

// Hard-delete a size. Soft-delete is `PATCH { active: false }` — prefer
// that to keep styles that already picked this size resolving (the render
// path falls back to the output's stored dims when a size is gone, but the
// readable name is lost). Existing per-style picks keep their snapshotted
// widthMm/heightMm either way.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  try {
    await db.infoAreaSize.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

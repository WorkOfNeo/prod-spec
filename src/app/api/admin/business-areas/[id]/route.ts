import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  // Renaming mondayValue is allowed but risky — it's how ingest resolves
  // the BA from Monday's emitted dropdown value. Surface a 409 on collision
  // so the admin sees the conflict instead of crashing.
  mondayValue: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
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

  if (parsed.data.mondayValue) {
    const collision = await db.businessArea.findUnique({
      where: { mondayValue: parsed.data.mondayValue },
    });
    if (collision && collision.id !== id) {
      return NextResponse.json(
        { error: `Another business area already uses mondayValue "${parsed.data.mondayValue}"` },
        { status: 409 },
      );
    }
  }

  const updated = await db.businessArea.update({
    where: { id },
    data: {
      ...(parsed.data.mondayValue !== undefined ? { mondayValue: parsed.data.mondayValue } : {}),
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  });

  return NextResponse.json({ businessArea: updated });
}

// Hard-delete is risky — Style.businessAreaId FKs to this row with
// ON DELETE SET NULL, and ProdSpec FKs with ON DELETE RESTRICT. So this
// will fail if any ProdSpec is attached, which is the correct safety
// behaviour. Prefer toggling `active = false` for soft-deletion.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  try {
    await db.businessArea.delete({ where: { id } });
  } catch (err) {
    return NextResponse.json(
      { error: `Cannot delete — a ProdSpec is attached. Toggle Active off instead. (${(err as Error).message})` },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}

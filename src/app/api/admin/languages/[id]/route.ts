import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// `code` is intentionally immutable on update — renaming would orphan
// every translation map keyed by the old code. The "right" rename flow
// is: add a new row, copy translations across, deactivate the old.
const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(120).optional(),
  nativeName: z.string().max(120).nullable().optional(),
  sortOrder: z.number().int().optional(),
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
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const language = await db.language.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.nativeName !== undefined ? { nativeName: parsed.data.nativeName } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  });
  return NextResponse.json({ language });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  // Hard-delete. Translations keyed by this code stay in their JSON maps
  // but stop rendering once the Language row is gone (the editor filters
  // by active Languages). Soft-delete via PATCH { active: false } is safer
  // when you want the data to be re-activatable later.
  await db.language.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

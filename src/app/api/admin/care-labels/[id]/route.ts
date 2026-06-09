import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateCareLabelCache, toSymbolCodeArray, toLaunderingAction } from "@/lib/care-labels";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  sourceText: z.string().min(1).max(400).optional(),
  sortOrder: z.number().int().optional(),
  // Laundering action — coerced against the canonical set (unknown ⇒ null);
  // only written when present in the body.
  action: z.string().max(32).nullable().optional(),
  showIfSymbols: z.array(z.string()).optional(),
  hideIfSymbols: z.array(z.string()).optional(),
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

  const updated = await db.careLabel.update({
    where: { id },
    data: {
      ...(parsed.data.sourceText !== undefined ? { sourceText: parsed.data.sourceText } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.action !== undefined
        ? { action: toLaunderingAction(parsed.data.action) }
        : {}),
      ...(parsed.data.showIfSymbols !== undefined
        ? { showIfSymbols: toSymbolCodeArray(parsed.data.showIfSymbols) }
        : {}),
      ...(parsed.data.hideIfSymbols !== undefined
        ? { hideIfSymbols: toSymbolCodeArray(parsed.data.hideIfSymbols) }
        : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  });
  invalidateCareLabelCache();
  return NextResponse.json({ careLabel: updated });
}

// Hard-delete a care label. Soft-delete is `PATCH { active: false }` —
// prefer that to keep the line around without printing it.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  await db.careLabel.delete({ where: { id } });
  invalidateCareLabelCache();
  return NextResponse.json({ ok: true });
}

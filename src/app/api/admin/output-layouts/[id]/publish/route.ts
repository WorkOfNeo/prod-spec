import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { validateLayoutForPublish } from "@/lib/output-layouts/publish-validation";
import { refreshLayoutVariants } from "@/lib/output-layouts/variants";

export const runtime = "nodejs";

// Publish a layout: validate the definition strictly (unknown variables
// and malformed args are publish blockers, not just preview warnings),
// bump the version, flip to PUBLISHED, refresh the variant registry.
// A published layout appears in the ProdSpec output picker but only
// generates once an operator explicitly adds it to a ProdSpec.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const layout = await db.outputLayout.findUnique({ where: { id } });
  if (!layout) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The strict gate lives in publish-validation.ts so a reviewed draft
  // (publishRevision) can never reach print through a looser check than this
  // button. Both failure kinds answer 422 with { error, details }.
  const validation = validateLayoutForPublish(layout.definition);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error, details: validation.details }, { status: 422 });
  }

  const updated = await db.outputLayout.update({
    where: { id },
    data: { status: "PUBLISHED", version: { increment: 1 } },
  });
  await refreshLayoutVariants();

  return NextResponse.json({
    layout: { id: updated.id, status: updated.status, version: updated.version },
    variantKey: `layout:${updated.id}`,
  });
}

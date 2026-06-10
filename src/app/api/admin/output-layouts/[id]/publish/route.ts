import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { CONTROL_RE, IF_RE, LayoutDefSchema, tokensInDef } from "@/lib/output-layouts/schema";
import { validateLineConditionals, validateTokenRef } from "@/lib/output-layouts/token-meta";
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

  const defParse = LayoutDefSchema.safeParse(layout.definition);
  if (!defParse.success) {
    return NextResponse.json(
      { error: "Layout definition is invalid", details: defParse.error.issues.map((i) => i.message) },
      { status: 422 },
    );
  }
  const def = defParse.data;

  const problems: string[] = [];
  for (const ref of tokensInDef(def)) {
    problems.push(...validateTokenRef(ref.key, ref.arg));
  }
  // Conditional syntax — malformed {{if}}/{{else}}/{{endif}} is a publish
  // blocker, not just a preview oddity.
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        problems.push(...validateLineConditionals(line, IF_RE, CONTROL_RE));
      }
    }
  }
  const blockCount = def.pages.reduce((n, p) => n + p.blocks.length, 0);
  if (blockCount === 0) problems.push("layout has no blocks — nothing would print");

  if (problems.length > 0) {
    return NextResponse.json({ error: "Layout can't be published", details: problems }, { status: 422 });
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

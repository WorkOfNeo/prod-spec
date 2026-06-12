import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { LayoutDefSchema } from "@/lib/output-layouts/schema";
import { refreshLayoutVariants } from "@/lib/output-layouts/variants";
import { loadDocTypes } from "@/lib/pdf/doc-types-db";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const layout = await db.outputLayout.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      businessArea: { select: { id: true, name: true } },
    },
  });
  if (!layout) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ layout });
}

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(120).optional(),
  // Shape-validated here; membership is checked against the doc_types
  // catalogue in the handler (the list is DB-managed, not a static enum).
  docType: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
  definition: LayoutDefSchema.optional(),
  // Test-data binding (which customer × BA the builder previews with) —
  // null clears it.
  customerId: z.string().min(1).nullable().optional(),
  businessAreaId: z.string().min(1).nullable().optional(),
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
  const d = parsed.data;
  if (d.docType !== undefined) {
    const known = await loadDocTypes();
    if (!known.some((t) => t.value === d.docType)) {
      return NextResponse.json(
        { error: `Unknown doc type "${d.docType}" — add it under Custom outputs → Document types first` },
        { status: 400 },
      );
    }
  }

  try {
    const layout = await db.outputLayout.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.docType !== undefined ? { docType: d.docType } : {}),
        ...(d.definition !== undefined ? { definition: d.definition as object } : {}),
        ...(d.customerId !== undefined ? { customerId: d.customerId } : {}),
        ...(d.businessAreaId !== undefined ? { businessAreaId: d.businessAreaId } : {}),
      },
    });
    // Edits to a PUBLISHED layout take effect on future renders
    // immediately (per the agreed model: ProdSpec linking controls usage,
    // not versioned re-publish) — refresh the in-process registry.
    if (layout.status === "PUBLISHED") await refreshLayoutVariants();
    return NextResponse.json({ layout: { id: layout.id, status: layout.status, version: layout.version } });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  try {
    const layout = await db.outputLayout.delete({ where: { id } });
    // ProdSpec rows that still reference layout:<id> keep their entry;
    // the runner logs + skips unknown variant keys (same path as a
    // removed coded variant), and the editor shows the stale key.
    if (layout.status === "PUBLISHED") await refreshLayoutVariants();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

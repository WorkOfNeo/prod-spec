import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { TEMPLATE_VARIANTS } from "@/lib/pdf/template-registry";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  label: z.string().min(2).max(60),
});

// Label rename — display-only, safe any time (the value is the storage
// key and stays immutable).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ value: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { value } = await ctx.params;
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
    const row = await db.docTypeDef.update({
      where: { value },
      data: { label: parsed.data.label.trim() },
    });
    return NextResponse.json({ type: { value: row.value, label: row.label } });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

// Delete — only when nothing carries the value: no builder layouts, no
// generated assets, no legacy templates, and no CODED variant in the
// registry (those exist regardless of the DB).
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ value: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { value } = await ctx.params;
  if (TEMPLATE_VARIANTS.some((v) => v.docType === value)) {
    return NextResponse.json(
      { error: "This type is used by built-in template variants and can't be deleted" },
      { status: 409 },
    );
  }
  const [layouts, assets, templates] = await Promise.all([
    db.outputLayout.count({ where: { docType: value } }),
    db.jobAsset.count({ where: { docType: value } }),
    db.template.count({ where: { docType: value } }),
  ]);
  if (layouts + assets + templates > 0) {
    return NextResponse.json(
      {
        error: `Still in use — ${layouts} layout(s), ${assets} generated asset(s), ${templates} template(s). Re-type those first.`,
      },
      { status: 409 },
    );
  }
  try {
    await db.docTypeDef.delete({ where: { value } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

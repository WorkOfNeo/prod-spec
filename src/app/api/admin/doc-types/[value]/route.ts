import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { TEMPLATE_VARIANTS } from "@/lib/pdf/template-registry";
import { parseOutputRules, type OutputRule } from "@/lib/outputs/exclusion";

export const runtime = "nodejs";

const RULE_SCHEMA = z.object({
  field: z.string().min(1).max(60),
  op: z.enum(["contains", "equals"]),
  keywords: z.array(z.string().max(120)).max(50),
  // "exclude" (don't generate when it matches) is the default and what every
  // rule written before modes existed means; "include" flips it to "generate
  // ONLY when it matches". See src/lib/outputs/exclusion.ts.
  mode: z.enum(["exclude", "include"]).optional(),
});

// Either a label rename, the exclusion rules, or both. Both are safe any time
// (the `value` storage key stays immutable).
const PATCH_SCHEMA = z
  .object({
    label: z.string().min(2).max(60).optional(),
    exclusionRules: z.array(RULE_SCHEMA).max(50).optional(),
  })
  .refine((d) => d.label !== undefined || d.exclusionRules !== undefined, {
    message: "Provide a label and/or exclusionRules",
  });

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

  const data: { label?: string; exclusionRules?: OutputRule[] } = {};
  if (parsed.data.label !== undefined) data.label = parsed.data.label.trim();
  // Normalise through the shared parser (trims keywords, drops blanks/empties)
  // so the stored JSON is always clean regardless of what the client sent.
  if (parsed.data.exclusionRules !== undefined) {
    data.exclusionRules = parseOutputRules(parsed.data.exclusionRules);
  }

  try {
    const row = await db.docTypeDef.update({ where: { value }, data });
    return NextResponse.json({
      type: { value: row.value, label: row.label, rules: parseOutputRules(row.exclusionRules) },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // P2022 = column missing → the exclusionRules migration isn't applied yet.
    if (code === "P2022") {
      return NextResponse.json(
        { error: "exclusionRules column missing — apply the pending migration (npm run db:deploy)" },
        { status: 503 },
      );
    }
    if (code === "P2025") return NextResponse.json({ error: "Not found" }, { status: 404 });
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

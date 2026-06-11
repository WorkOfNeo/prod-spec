import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  BundlePageSettingsSchema,
  ProdSpecOutputsSchema,
  parseProdSpecLanguages,
} from "@/lib/prod-spec/config";
import { ColumnMappingSchema, RequiredFieldSchema } from "@/lib/customers/config";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
  autoGenerateThresholdPct: z.number().int().min(0).max(100).optional(),
  outputs: ProdSpecOutputsSchema.optional(),
  // Logo: either raw SVG markup (typically <10 KB) or a raster data URL
  // ("data:image/png;base64,…" / jpeg) when the operator uploads a
  // PNG/JPG. Cap accommodates a ~2 MB raster, which base64-encodes to
  // ~2.7 MB of string.
  logoSvg: z.string().max(4_000_000).nullable().optional(),
  // Markdown for the "General information" A4 page included in every
  // generated bundle. 100k chars is many pages — a generous ceiling that
  // still stops accidental paste bombs.
  generalInfoMd: z.string().max(100_000).nullable().optional(),
  // Print tuning for the two bundle framing pages — margins (mm), base
  // font (pt), line height, footer toggle; one block per page. Validated
  // against the canonical schema so out-of-range values 400 instead of
  // landing in the column.
  bundlePageSettings: BundlePageSettingsSchema.optional(),
  // Free-text per-language map. Lang keys are coerced to lowercase server-side.
  careInstructionsByLang: z.record(z.string().min(1), z.string().max(2000)).optional(),
  columnMapping: ColumnMappingSchema.optional(),
  requiredFields: z.array(RequiredFieldSchema).optional(),
  // Optional supplier set — if present, replaces the entire attached list.
  supplierIds: z.array(z.string().min(1)).optional(),
  // Output language codes (lowercase) this prod spec renders. Deliberately
  // excluded from `hasOtherChange` below: toggling languages (from the
  // editor or the /prod-specs/languages matrix) must not auto-activate a
  // draft prod spec.
  outputLanguages: z.array(z.string().min(1)).optional(),
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
  const existing = await db.prodSpec.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Auto-activation: if the admin touched any non-active field, treat
  // the save as approval and flip `active = true`. Explicit `active`
  // wins (so the admin can deactivate something they're about to retire
  // even while editing it). Empty PATCH bodies leave `active` alone.
  const hasOtherChange =
    d.name !== undefined ||
    d.autoGenerateThresholdPct !== undefined ||
    d.outputs !== undefined ||
    d.logoSvg !== undefined ||
    d.generalInfoMd !== undefined ||
    d.bundlePageSettings !== undefined ||
    d.careInstructionsByLang !== undefined ||
    d.columnMapping !== undefined ||
    d.requiredFields !== undefined ||
    d.supplierIds !== undefined;
  const resolvedActive =
    d.active !== undefined ? d.active : hasOtherChange ? true : undefined;

  // Wrap the field update + supplier-set replacement in a transaction so a
  // partial save can't leave the join table inconsistent with the row.
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.prodSpec.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(resolvedActive !== undefined ? { active: resolvedActive } : {}),
        ...(d.autoGenerateThresholdPct !== undefined ? { autoGenerateThresholdPct: d.autoGenerateThresholdPct } : {}),
        ...(d.outputs !== undefined ? { outputs: d.outputs as unknown as object } : {}),
        ...(d.logoSvg !== undefined ? { logoSvg: d.logoSvg } : {}),
        ...(d.generalInfoMd !== undefined
          ? { generalInfoMd: d.generalInfoMd?.trim() ? d.generalInfoMd : null }
          : {}),
        ...(d.bundlePageSettings !== undefined
          ? { bundlePageSettings: d.bundlePageSettings as unknown as object }
          : {}),
        ...(d.careInstructionsByLang !== undefined
          ? {
              careInstructionsByLang: Object.fromEntries(
                Object.entries(d.careInstructionsByLang)
                  .filter(([, v]) => v.trim().length > 0)
                  .map(([k, v]) => [k.toLowerCase(), v]),
              ) as unknown as object,
            }
          : {}),
        ...(d.columnMapping !== undefined ? { columnMapping: d.columnMapping as unknown as object } : {}),
        ...(d.requiredFields !== undefined ? { requiredFields: d.requiredFields as unknown as object } : {}),
        ...(d.outputLanguages !== undefined ? { outputLanguages: parseProdSpecLanguages(d.outputLanguages) } : {}),
      },
    });

    if (d.supplierIds !== undefined) {
      const wanted = new Set(d.supplierIds);
      const current = await tx.prodSpecSupplier.findMany({ where: { prodSpecId: id } });
      const currentIds = new Set(current.map((c) => c.supplierId));

      const toCreate = d.supplierIds.filter((sid) => !currentIds.has(sid));
      const toRemove = current.filter((c) => !wanted.has(c.supplierId));

      if (toRemove.length > 0) {
        await tx.prodSpecSupplier.deleteMany({
          where: { id: { in: toRemove.map((r) => r.id) } },
        });
      }
      if (toCreate.length > 0) {
        await tx.prodSpecSupplier.createMany({
          data: toCreate.map((supplierId) => ({ prodSpecId: id, supplierId })),
          skipDuplicates: true,
        });
      }
    }

    return updated;
  });

  return NextResponse.json({ prodSpec: result });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { MANUAL_COLUMN_IDS, parseCustomerConfig } from "@/lib/customers/config";
import { evaluateCompletion } from "@/lib/monday/completion";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";
import { ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";
import type { MondayItem } from "@/lib/monday/client";

export const runtime = "nodejs";
export const maxDuration = 300;

// Same payload shape as POST /api/admin/styles/manual, all fields
// optional. Edit-and-rerender is handled in one round-trip when
// `regenerate: true` (default).
const PATCH_SCHEMA = z.object({
  supplierId: z.string().min(1).nullable().optional(),
  businessAreaId: z.string().min(1).nullable().optional(),
  styleName: z.string().min(1).max(200).optional(),
  styleNumber: z.string().min(1).max(64).optional(),
  businessArea: z.string().min(1).optional(),
  composition: z.string().optional(),
  productNameTranslations: z.string().optional(),
  washSymbolCodes: z.array(z.string().min(1)).optional(),
  sizes: z.string().optional(),
  ean13: z.string().optional(),
  klNumber: z.string().optional(),
  supplierNumber: z.string().optional(),
  lot: z.string().optional(),
  cartonQty: z.string().optional(),
  cartonEan: z.string().optional(),
  colourName: z.string().optional(),
  colourCode: z.string().optional(),
  price: z.string().optional(),
  supplierEmail: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  qrImageId: z.string().min(1).nullable().optional(),
  regenerate: z.boolean().default(true),
});

type Patch = z.infer<typeof PATCH_SCHEMA>;

function readColumn(item: MondayItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? "";
}

// Overlay a form patch onto the existing synthetic Monday item WITHOUT
// discarding the synced columns. The edit form only carries the
// manual-entry fields, so we update the matching `manual.*` columns and
// leave everything else — the synced Monday columns AND the `po.*`
// Pre-Order enrichment — exactly as ingest wrote them.
//
// This is deliberate: the renderer and the edit form both read the
// mapped (synced) column first and fall back to `manual.*` only when it's
// empty. So a hand-typed value just fills a gap; whatever Monday syncs
// stays authoritative and supersedes the manual entry on the next sync.
// (The previous implementation REPLACED column_values with only the
// manual.* set, silently wiping synced data on every save.)
function mergeSyntheticItem(existing: MondayItem, patch: Patch, styleName: string): MondayItem {
  // Desired text per manual.* id. `undefined` means "not in this patch"
  // → keep whatever is already stored for that manual column.
  const manualText = (id: string, value: string | undefined): string =>
    value !== undefined ? value : readColumn(existing, id);

  const manual: Array<[string, string]> = [
    [MANUAL_COLUMN_IDS.styleNumber, manualText(MANUAL_COLUMN_IDS.styleNumber, patch.styleNumber)],
    [MANUAL_COLUMN_IDS.businessArea, manualText(MANUAL_COLUMN_IDS.businessArea, patch.businessArea)],
    [MANUAL_COLUMN_IDS.composition, manualText(MANUAL_COLUMN_IDS.composition, patch.composition)],
    [
      MANUAL_COLUMN_IDS.productNameTranslations,
      manualText(MANUAL_COLUMN_IDS.productNameTranslations, patch.productNameTranslations),
    ],
    [
      MANUAL_COLUMN_IDS.washCare,
      manualText(
        MANUAL_COLUMN_IDS.washCare,
        patch.washSymbolCodes ? patch.washSymbolCodes.join(",") : undefined,
      ),
    ],
    [MANUAL_COLUMN_IDS.sizes, manualText(MANUAL_COLUMN_IDS.sizes, patch.sizes)],
    [MANUAL_COLUMN_IDS.ean13, manualText(MANUAL_COLUMN_IDS.ean13, patch.ean13)],
    [MANUAL_COLUMN_IDS.klNumber, manualText(MANUAL_COLUMN_IDS.klNumber, patch.klNumber)],
    [MANUAL_COLUMN_IDS.supplierNumber, manualText(MANUAL_COLUMN_IDS.supplierNumber, patch.supplierNumber)],
    [MANUAL_COLUMN_IDS.lot, manualText(MANUAL_COLUMN_IDS.lot, patch.lot)],
    [MANUAL_COLUMN_IDS.cartonQty, manualText(MANUAL_COLUMN_IDS.cartonQty, patch.cartonQty)],
    [MANUAL_COLUMN_IDS.cartonEan, manualText(MANUAL_COLUMN_IDS.cartonEan, patch.cartonEan)],
    [MANUAL_COLUMN_IDS.colourName, manualText(MANUAL_COLUMN_IDS.colourName, patch.colourName)],
    [MANUAL_COLUMN_IDS.colourCode, manualText(MANUAL_COLUMN_IDS.colourCode, patch.colourCode)],
    [MANUAL_COLUMN_IDS.price, manualText(MANUAL_COLUMN_IDS.price, patch.price)],
    [MANUAL_COLUMN_IDS.supplierEmail, manualText(MANUAL_COLUMN_IDS.supplierEmail, patch.supplierEmail)],
    [
      MANUAL_COLUMN_IDS.countryOfOrigin,
      manualText(MANUAL_COLUMN_IDS.countryOfOrigin, patch.countryOfOrigin),
    ],
  ];
  const manualById = new Map(manual);

  // Update manual.* columns in place; leave all other columns untouched.
  const seen = new Set<string>();
  const columns: MondayItem["column_values"] = existing.column_values.map((c) => {
    const next = manualById.get(c.id);
    if (next === undefined) return c;
    seen.add(c.id);
    return { ...c, type: c.type ?? "text", text: next, value: null };
  });
  // Append any manual.* columns the item didn't have yet.
  for (const [id, text] of manual) {
    if (!seen.has(id)) columns.push({ id, type: "text", text, value: null });
  }

  return {
    ...existing,
    name: patch.styleName ?? styleName,
    column_values: columns,
  };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PATCH_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  const style = await db.style.findUnique({
    where: { id },
    include: { customer: true },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const inflight = await db.job.count({
    where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (patch.regenerate && inflight > 0) {
    return NextResponse.json(
      { error: "A job is already in flight for this style — wait or skip regenerate" },
      { status: 409 },
    );
  }

  // Re-resolve ProdSpec if the BA changed (auto-create if needed).
  const businessAreaIdResolved =
    patch.businessAreaId !== undefined ? patch.businessAreaId : style.businessAreaId;
  let prodSpecId = style.prodSpecId;
  if (patch.businessAreaId !== undefined) {
    prodSpecId = businessAreaIdResolved
      ? await (async () => {
          await ensureProdSpecsForStyle(style.customerId, businessAreaIdResolved);
          const ps = await db.prodSpec.findUnique({
            where: { customerId_businessAreaId: { customerId: style.customerId, businessAreaId: businessAreaIdResolved } },
          });
          return ps?.id ?? null;
        })()
      : null;
  }

  const existingItem = style.rawData as unknown as MondayItem;
  const newItem = mergeSyntheticItem(existingItem, patch, style.name);

  const config = parseCustomerConfig(style.customer.config);
  const { completionPct, missingFields } = evaluateCompletion(newItem, config.requiredFields);

  const updated = await db.style.update({
    where: { id },
    data: {
      name: patch.styleName ?? style.name,
      businessArea: patch.businessArea ?? style.businessArea,
      businessAreaId: businessAreaIdResolved,
      supplierId: patch.supplierId !== undefined ? patch.supplierId : style.supplierId,
      qrImageId: patch.qrImageId !== undefined ? patch.qrImageId : style.qrImageId,
      prodSpecId,
      rawData: newItem as unknown as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      // Status flip: only when not currently awaiting/approved/rejected
      // — those carry meaning we shouldn't overwrite from an edit. For
      // PENDING/READY/GENERATING we recompute fresh.
      ...(["PENDING", "READY", "GENERATING"].includes(style.status)
        ? { status: completionPct === 100 ? "READY" : "PENDING" }
        : {}),
      lastSyncedAt: new Date(),
    },
  });

  if (!patch.regenerate) {
    return NextResponse.json({ styleId: updated.id, regenerated: false });
  }

  const { jobId } = await enqueueGenerationJob({ styleId: updated.id, triggerSource: "MANUAL_RERUN" });
  await db.log.create({
    data: { jobId, level: "INFO", message: `style edited and re-rendered by ${auth.userId}` },
  });
  const summary = await runPendingJobs(1);

  return NextResponse.json({
    styleId: updated.id,
    jobId,
    regenerated: true,
    jobsProcessed: summary.processed,
    jobsFailed: summary.failed,
  });
}

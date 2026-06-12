import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { MANUAL_COLUMN_IDS, parseCustomerConfig } from "@/lib/customers/config";
import { evaluateCompletion } from "@/lib/monday/completion";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";
import type { MondayItem } from "@/lib/monday/client";
import { ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";

export const runtime = "nodejs";
export const maxDuration = 300;

const BODY_SCHEMA = z.object({
  customerId: z.string().min(1),
  supplierId: z.string().min(1).nullable().optional(),
  // Either the BusinessArea row id (preferred — resolves Style.businessAreaId
  // and the matching ProdSpec) or just a free-text label as fallback.
  businessAreaId: z.string().min(1).nullable().optional(),
  styleName: z.string().min(1).max(200),
  styleNumber: z.string().min(1).max(64),
  businessArea: z.string().min(1),
  composition: z.string().default(""),
  productNameTranslations: z.string().default(""),
  // Multi-select of WashSymbol codes. Stored as a comma-joined string in
  // the synthetic Monday column (mapper splits it back to an array).
  washSymbolCodes: z.array(z.string().min(1)).default([]),
  sizes: z.string().default(""),
  ean13: z.string().default(""),
  klNumber: z.string().default(""),
  supplierNumber: z.string().default(""),
  lot: z.string().default(""),
  cartonQty: z.string().default(""),
  cartonEan: z.string().default(""),
  colourName: z.string().default(""),
  colourCode: z.string().default(""),
  price: z.string().default(""),
  supplierEmail: z.string().default(""),
  countryOfOrigin: z.string().default(""),
  qrImageId: z.string().min(1).nullable().optional(),
  logoImageId: z.string().min(1).nullable().optional(),
});

type ManualBody = z.infer<typeof BODY_SCHEMA>;

function buildSyntheticItem(body: ManualBody, syntheticId: string): MondayItem {
  const mk = (id: string, text: string) => ({ id, type: "text", text, value: null });
  return {
    id: syntheticId,
    name: body.styleName,
    board: { id: "manual" },
    group: null,
    column_values: [
      mk(MANUAL_COLUMN_IDS.styleNumber, body.styleNumber),
      mk(MANUAL_COLUMN_IDS.businessArea, body.businessArea),
      mk(MANUAL_COLUMN_IDS.composition, body.composition),
      mk(MANUAL_COLUMN_IDS.productNameTranslations, body.productNameTranslations),
      mk(MANUAL_COLUMN_IDS.washCare, body.washSymbolCodes.join(",")),
      mk(MANUAL_COLUMN_IDS.sizes, body.sizes),
      mk(MANUAL_COLUMN_IDS.ean13, body.ean13),
      mk(MANUAL_COLUMN_IDS.klNumber, body.klNumber),
      mk(MANUAL_COLUMN_IDS.supplierNumber, body.supplierNumber),
      mk(MANUAL_COLUMN_IDS.lot, body.lot),
      mk(MANUAL_COLUMN_IDS.cartonQty, body.cartonQty),
      mk(MANUAL_COLUMN_IDS.cartonEan, body.cartonEan),
      mk(MANUAL_COLUMN_IDS.colourName, body.colourName),
      mk(MANUAL_COLUMN_IDS.colourCode, body.colourCode),
      mk(MANUAL_COLUMN_IDS.price, body.price),
      mk(MANUAL_COLUMN_IDS.supplierEmail, body.supplierEmail),
      mk(MANUAL_COLUMN_IDS.countryOfOrigin, body.countryOfOrigin),
    ],
  };
}

function newSyntheticItemId(): string {
  return `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Auto-resolve / auto-create the ProdSpec for the (customer, businessArea)
// pair when both FKs are known — matches the ingest path's behaviour so
// manual styles render with the same ProdSpec config that webhook'd ones
// would.
async function resolveProdSpec(
  customerId: string,
  businessAreaId: string | null | undefined,
): Promise<string | null> {
  if (!businessAreaId) return null;
  await ensureProdSpecsForStyle(customerId, businessAreaId);
  const ps = await db.prodSpec.findUnique({
    where: { customerId_businessAreaId: { customerId, businessAreaId } },
  });
  return ps?.id ?? null;
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const customer = await db.customer.findUnique({ where: { id: body.customerId } });
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  const config = parseCustomerConfig(customer.config);

  const syntheticId = newSyntheticItemId();
  const item = buildSyntheticItem(body, syntheticId);

  const { completionPct, missingFields } = evaluateCompletion(item, config.requiredFields);
  const prodSpecId = await resolveProdSpec(customer.id, body.businessAreaId);

  const style = await db.style.create({
    data: {
      customerId: customer.id,
      supplierId: body.supplierId ?? null,
      businessAreaId: body.businessAreaId ?? null,
      qrImageId: body.qrImageId ?? null,
      logoImageId: body.logoImageId ?? null,
      prodSpecId,
      mondayItemId: syntheticId,
      mondayBoardId: "manual",
      name: body.styleName,
      businessArea: body.businessArea,
      rawData: item as unknown as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      status: completionPct === 100 ? "READY" : "PENDING",
      lastSyncedAt: new Date(),
    },
  });

  await enqueueGenerationJob({ styleId: style.id, triggerSource: "ADMIN_TEST" });
  const summary = await runPendingJobs(1);

  return NextResponse.json({
    styleId: style.id,
    jobsProcessed: summary.processed,
    jobsFailed: summary.failed,
  });
}

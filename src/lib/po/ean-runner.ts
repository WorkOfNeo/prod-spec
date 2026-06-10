import { db } from "@/lib/db";
import type { StyleEanStatus as DbEanStatus } from "@/generated/prisma/enums";
import type { MondayItem } from "@/lib/monday/client";
import { evaluateCompletion, withSyntheticColumns } from "@/lib/monday/completion";
import { parseCustomerConfig, MANUAL_COLUMN_IDS } from "@/lib/customers/config";
import { parseProdSpecRequiredFields, parseProdSpecColumnMapping } from "@/lib/prod-spec/config";
import { formatEanMap } from "@/lib/styles/resolved-fields";
import { resolveStyleEans, type StyleEanStatus as ResolveStatus } from "./resolve-style-eans";
import type { EanView } from "./ean-view";

// =====================================================
// EAN resolution runner.
//
// The Style.eanStatus column doubles as the work queue: a Style lands in
// PENDING when its PO number is filled (Monday ingest), and this runner —
// driven by /api/po-eans/run (Railway cron + the fire-and-forget trigger) —
// drains PENDING rows, scrapes the PO PDF via the existing resolveStyleEans()
// pipeline, and persists the per-size EANs into style_eans plus the carton
// EAN + status onto the Style.
//
// Concurrency-safe via FOR UPDATE SKIP LOCKED (mirrors src/lib/queue/runner).
// PO_FOUND_NO_EANS / PO_NOT_FOUND / ERROR rows are re-queued by the sweep so
// they resolve automatically once the supplier adds the barcode page to the PO.
// =====================================================

// A claimed RESOLVING row older than this is assumed dead and recovered to
// PENDING (mirrors the PDF runner's stale-RUNNING window).
const STALE_RESOLVING_MS = 15 * 60 * 1000;

// How long before a non-terminal outcome (no barcode page yet, PO PDF not
// found, transient error) is retried by the sweep.
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

// Statuses the sweep re-queues — all "might succeed later" outcomes.
const RETRYABLE: DbEanStatus[] = ["PO_FOUND_NO_EANS", "PO_NOT_FOUND", "ERROR"];

export type EanRunSummary = {
  processed: number;
  failed: number;
  requeued: number;
  styleIds: string[];
};

export async function runPendingEanResolutions(
  limit = 5,
  opts: { sweep?: boolean } = {},
): Promise<EanRunSummary> {
  const summary: EanRunSummary = { processed: 0, failed: 0, requeued: 0, styleIds: [] };

  await releaseStaleResolving();
  if (opts.sweep) summary.requeued = await requeueRetryable();

  for (let i = 0; i < limit; i++) {
    const claimed = await claimNextPendingStyle();
    if (!claimed) break;
    summary.styleIds.push(claimed.id);
    try {
      await resolveAndPersistStyleEans(claimed.id);
      summary.processed++;
    } catch (err) {
      summary.failed++;
      await markEanError(claimed.id, (err as Error).message);
    }
  }

  return summary;
}

// Atomically claim the oldest PENDING style and flip it to RESOLVING so a
// second runner pass can't pick up the same row mid-download.
async function claimNextPendingStyle(): Promise<{ id: string } | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE styles
    SET "eanStatus" = 'RESOLVING', "eanResolveStartedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM styles
      WHERE "eanStatus" = 'PENDING'
      ORDER BY "updatedAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  return rows[0] ?? null;
}

async function releaseStaleResolving(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RESOLVING_MS);
  const released = await db.style.updateMany({
    where: { eanStatus: "RESOLVING", eanResolveStartedAt: { lt: cutoff } },
    data: { eanStatus: "PENDING", eanResolveStartedAt: null },
  });
  if (released.count > 0) {
    await db.log.create({
      data: {
        level: "WARN",
        message: `released ${released.count} stale RESOLVING styles back to PENDING`,
      },
    });
  }
}

// Re-queue PO'd styles that should still be resolved. Makes the cron
// self-healing: it picks up styles that were never queued (NONE — e.g.
// existing rows after the migration backfilled the column) and retries the
// "didn't fully resolve yet" outcomes (no barcode page, PO not found,
// transient error) once the retry window has passed. Terminal-good states
// (RESOLVED / PARTIAL) and no-PO rows are left untouched.
async function requeueRetryable(): Promise<number> {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS);
  const requeued = await db.style.updateMany({
    where: {
      poNumber: { not: null },
      OR: [
        // Never queued — covers existing styles after the migration backfill.
        { eanStatus: "NONE" },
        // Non-terminal outcomes, retried once the window passes.
        // eanResolvedAt is set on every terminal write; null = never attempted.
        { eanStatus: { in: RETRYABLE }, eanResolvedAt: { lt: cutoff } },
        { eanStatus: { in: RETRYABLE }, eanResolvedAt: null },
      ],
    },
    data: { eanStatus: "PENDING" },
  });
  return requeued.count;
}

// Resolve one style end-to-end, persist the result, and return a UI-ready
// view. Used by both the runner loop and the admin "Re-resolve" endpoint so a
// manual resolve persists exactly like a queued one. Throws on unexpected
// failure (the runner catches it and marks ERROR; the route surfaces a 500).
export async function resolveAndPersistStyleEans(styleId: string): Promise<EanView> {
  const result = await resolveStyleEans(styleId);
  const dbStatus = toDbStatus(result.status);
  const withEan = result.sizeEans.filter((s) => s.ean13).length;

  await db.$transaction([
    // Replace the per-size rows wholesale — simplest correct way to keep
    // style_eans in lockstep with the latest PO read (sizes can change).
    db.styleEan.deleteMany({ where: { styleId } }),
    ...result.sizeEans.map((s, i) =>
      db.styleEan.create({
        data: {
          styleId,
          position: i,
          size: s.size,
          ean13: s.ean13,
          variantLabel: s.variantLabel,
        },
      }),
    ),
    db.style.update({
      where: { id: styleId },
      data: {
        eanStatus: dbStatus,
        cartonEan: result.cartonEan,
        poFileName: result.poFileName,
        eanResolvedAt: new Date(),
        eanResolveStartedAt: null,
      },
    }),
    db.log.create({
      data: {
        // RESOLVED / PARTIAL are healthy; everything else is worth flagging
        // for review, so log it at WARN with the full diagnostics payload.
        level: dbStatus === "RESOLVED" || dbStatus === "PARTIAL" ? "INFO" : "WARN",
        message: `ean resolve ${styleId}: ${result.status} (${withEan}/${result.sizeEans.length} sizes${
          result.poFileName ? `, po=${result.poFileName}` : ""
        })`,
        // Full verification trail: chosen file + candidate list, barcode-page
        // detection, raw 13-digit token count, parsed items/variants and a
        // text snippet — so PO_FOUND_NO_EANS can be confirmed as "genuinely
        // no barcode page" vs "wrong file" vs "parser miss".
        payload: (result.diagnostics ?? undefined) as unknown as object,
      },
    }),
  ]);

  // Completion is evaluated at ingest, BEFORE the EANs resolve — recompute
  // it now so a style whose only gap was the barcodes flips to 100%/READY
  // the moment the scrape lands (and /styles stops reporting "EAN-13 (per
  // size)" as missing). Failure here must not fail the resolve itself.
  try {
    await recomputeStyleCompletion(styleId);
  } catch (err) {
    console.error(`[ean] ${styleId}: completion recompute failed:`, (err as Error).message);
  }

  // One-line summary in the dev/worker console with the decisive signals.
  const d = result.diagnostics;
  console.info(
    `[ean] ${styleId} → ${result.status}` +
      ` | file="${result.poFileName ?? "-"}"` +
      ` | candidates=${d?.candidateCount ?? "?"}` +
      ` | barcodePage=${d?.barcodePageFound ?? "?"}` +
      ` | ean13Tokens=${d?.ean13TokensInFullText ?? "?"}` +
      ` | items/variants=${d?.parsedItemCount ?? "?"}/${d?.parsedVariantCount ?? "?"}`,
  );

  return {
    status: dbStatus,
    message: result.message,
    poFileName: result.poFileName,
    sizeEans: result.sizeEans,
    cartonEan: result.cartonEan,
    diagnostics: result.diagnostics,
  };
}

async function markEanError(styleId: string, message: string): Promise<void> {
  // Print to stderr too — `next dev` swallows non-prisma logs otherwise.
  console.error(`[ean-runner] style ${styleId} FAILED: ${message}`);
  await db.style.update({
    where: { id: styleId },
    data: { eanStatus: "ERROR", eanResolvedAt: new Date(), eanResolveStartedAt: null },
  });
  await db.log.create({
    data: { level: "ERROR", message: `ean resolve ${styleId} failed: ${message}` },
  });
}

// Map the runtime resolution status onto the persisted DB enum.
function toDbStatus(s: ResolveStatus): DbEanStatus {
  switch (s) {
    case "ok":
      return "RESOLVED";
    case "partial":
      return "PARTIAL";
    case "no_eans":
      // PO PDF found + parsed, but no barcode/EAN page → "have PO, no EANs".
      return "PO_FOUND_NO_EANS";
    case "po_not_found":
      return "PO_NOT_FOUND";
    case "no_supplier_folder":
      return "PO_NOT_FOUND";
    case "no_po":
      return "NONE";
    case "error":
      return "ERROR";
    default:
      return "ERROR";
  }
}

// Re-evaluate Style.completionPct / missingFields / status after an EAN
// resolve, counting the freshly persisted barcodes as the ean13/cartonEan
// columns being filled. Mirrors the ingest-side evaluation exactly (same
// required-field precedence, same effective mapping, same synthetic-column
// injection) so the two paths can never disagree.
async function recomputeStyleCompletion(styleId: string): Promise<void> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      rawData: true,
      cartonEan: true,
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { requiredFields: true, columnMapping: true } },
    },
  });
  const item = style?.rawData as Pick<MondayItem, "column_values"> | null;
  if (!style || !item?.column_values) return;

  const customerConfig = parseCustomerConfig(style.customer.config);
  const prodSpecRequired = style.prodSpec
    ? parseProdSpecRequiredFields(style.prodSpec.requiredFields)
    : [];
  const requiredFields =
    prodSpecRequired.length > 0 ? prodSpecRequired : customerConfig.requiredFields;
  if (requiredFields.length === 0) return; // completion is already 100

  const psMappingRaw = style.prodSpec?.columnMapping;
  const mapping =
    psMappingRaw && typeof psMappingRaw === "object" && Object.keys(psMappingRaw).length > 0
      ? parseProdSpecColumnMapping(psMappingRaw)
      : customerConfig.columnMapping;
  const eanMapText = formatEanMap(style.eans);
  const completionItem = withSyntheticColumns(item, [
    { id: mapping.ean13 ?? "", text: eanMapText },
    { id: MANUAL_COLUMN_IDS.ean13, text: eanMapText },
    { id: mapping.cartonEan ?? "", text: style.cartonEan ?? "" },
    { id: MANUAL_COLUMN_IDS.cartonEan, text: style.cartonEan ?? "" },
  ]);
  const { completionPct, missingFields } = evaluateCompletion(completionItem, requiredFields);

  await db.style.update({
    where: { id: styleId },
    data: {
      completionPct,
      missingFields: missingFields as unknown as object,
      status: completionPct === 100 ? "READY" : "PENDING",
    },
  });
}

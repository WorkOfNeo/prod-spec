import { db } from "@/lib/db";
import { renderPdf } from "@/lib/pdf/renderer";
import { mapMondayItemToStyleData } from "@/lib/pdf/mapper";
import { effectiveStyleItem } from "@/lib/styles/resolved-fields";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import type { TemplateVariant } from "@/lib/pdf/template-registry";
import type { MondayItem } from "@/lib/monday/client";
import { sendEmail } from "@/lib/email/client";
import { reviewNotificationEmail } from "@/lib/email/templates/review-notification";
import { MANUAL_COLUMN_IDS, parseCustomerConfig } from "@/lib/customers/config";
import {
  DEFAULT_OUTPUTS,
  parseProdSpecColumnMapping,
  parseProdSpecLanguages,
  parseProdSpecOutputs,
  resolveOutputVariant,
  type ProdSpecOutput,
} from "@/lib/prod-spec/config";

const STALE_RUNNING_MS = 15 * 60 * 1000;

function toPlainBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}

export type RunSummary = {
  processed: number;
  failed: number;
  jobIds: string[];
};

export async function runPendingJobs(limit = 5): Promise<RunSummary> {
  const summary: RunSummary = { processed: 0, failed: 0, jobIds: [] };

  await releaseStaleRunning();

  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob();
    if (!job) break;
    summary.jobIds.push(job.id);
    try {
      await processJob(job.id);
      summary.processed++;
    } catch (err) {
      summary.failed++;
      await markFailed(job.id, (err as Error).message);
    }
  }

  return summary;
}

async function claimNextJob(): Promise<{ id: string } | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE jobs
    SET status = 'RUNNING', "startedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'QUEUED'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  return rows[0] ?? null;
}

async function releaseStaleRunning(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  const released = await db.job.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: { status: "QUEUED", startedAt: null },
  });
  if (released.count > 0) {
    await db.log.create({
      data: {
        level: "WARN",
        message: `released ${released.count} stale RUNNING jobs back to QUEUED`,
      },
    });
  }
}

export async function processJob(jobId: string): Promise<void> {
  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      style: {
        include: {
          customer: true,
          qrImage: true,
          supplier: { select: { country: true } },
          // Resolved PO barcodes — fall back into the ean13/cartonEan
          // fields at render time (see effectiveStyleItem).
          eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
        },
      },
    },
  });

  await db.log.create({ data: { jobId: job.id, level: "INFO", message: "job started" } });

  let config: ReturnType<typeof parseCustomerConfig>;
  try {
    config = parseCustomerConfig(job.style.customer.config);
  } catch (err) {
    throw new RunnerError("CONFIG_INVALID", `customer config invalid: ${(err as Error).message}`);
  }

  // Pull the ProdSpec (if resolved during ingest) so we can read its
  // per-output dimensions and supplier-specific overrides. When the Style
  // has no ProdSpec (manual entries, or ingests without a known BA), we
  // fall back to Customer.config-only defaults.
  const prodSpec = job.style.prodSpecId
    ? await db.prodSpec.findUnique({ where: { id: job.style.prodSpecId } })
    : null;

  let styleData: ReturnType<typeof mapMondayItemToStyleData>;
  try {
    // Inject the canonical Style.poNumber as the manual.* fallback so the PO
    // renders on labels (care-label-02) even when the mapped PO column isn't
    // the one this style's board populated — and the PO-PDF-resolved EANs /
    // carton EAN so barcodes render from the scrape. See effectiveStyleItem.
    const item = effectiveStyleItem({
      rawData: job.style.rawData,
      poNumber: job.style.poNumber,
      supplier: job.style.supplier,
      eans: job.style.eans,
      cartonEan: job.style.cartonEan,
    }) as MondayItem;
    // Resolution order for column mapping:
    //   1. ProdSpec.columnMapping  (when non-empty — operator override)
    //   2. Customer.config.columnMapping (when non-empty — per-tenant default)
    //   3. MANUAL_COLUMN_IDS  (only for `mondayBoardId === "manual"` styles —
    //      these are produced by /api/admin/styles/manual which writes the
    //      manual.* synthetic ids; without this fallback the mapper reads
    //      nothing and the PDF renders blank).
    //
    // Real Monday styles whose Customer has no column mapping yet still
    // render blank — that's the desired behaviour (forces the operator to
    // configure mapping before generating PDFs they'd just throw away).
    const prodSpecMapping =
      prodSpec && Object.keys(prodSpec.columnMapping as object).length > 0
        ? parseProdSpecColumnMapping(prodSpec.columnMapping)
        : null;
    const customerMapping =
      Object.keys(config.columnMapping).length > 0 ? config.columnMapping : null;
    const isManualStyle = job.style.mondayBoardId === "manual";
    const effectiveMapping =
      prodSpecMapping ??
      customerMapping ??
      (isManualStyle ? { ...MANUAL_COLUMN_IDS } : config.columnMapping);
    styleData = mapMondayItemToStyleData(
      item,
      {
        customerName: job.style.customer.name,
        customerLogoUrl: config.logoUrl,
        barcodeFont: config.barcodeFont,
        prodSpecLogoSvg: prodSpec?.logoSvg ?? null,
        careInstructionsByLang: parseCareInstructions(prodSpec?.careInstructionsByLang),
        outputLanguages: parseProdSpecLanguages(prodSpec?.outputLanguages),
        qrImageUrl: job.style.qrImage?.image ?? null,
      },
      effectiveMapping,
    );
  } catch (err) {
    throw new RunnerError("MAPPING_FAILED", `monday → style data mapping failed: ${(err as Error).message}`);
  }

  // Pick which variants to render. ProdSpec.outputs is the source of truth
  // when available — the operator selected those explicitly in the editor.
  // Falls back to DEFAULT_OUTPUTS (one of each variant) for manual styles
  // that haven't resolved a ProdSpec yet.
  let outputs: ProdSpecOutput[] = (() => {
    if (prodSpec) {
      const parsed = parseProdSpecOutputs(prodSpec.outputs);
      const enabled = parsed.filter((o) => o.enabled !== false);
      if (enabled.length > 0) return enabled;
    }
    return DEFAULT_OUTPUTS;
  })();

  // Per-output generation: a job may be scoped to specific variant keys (the
  // auto-enqueue paths set these to the outputs whose own required fields
  // just landed). Empty ⇒ render all enabled outputs (manual full regen /
  // legacy rows). When scoped, re-check each output's required fields at run
  // time so a field that regressed since enqueue doesn't ship an incomplete
  // output — not-ready ones are skipped (logged), not failed.
  const scopedKeys: string[] = Array.isArray(job.variantKeys)
    ? (job.variantKeys as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (scopedKeys.length > 0) {
    const want = new Set(scopedKeys);
    const readyKeys = new Set(
      (prodSpec
        ? outputReadinessForStyle({
            rawData: job.style.rawData,
            poNumber: job.style.poNumber,
            supplier: job.style.supplier,
            eans: job.style.eans,
            cartonEan: job.style.cartonEan,
            customer: { config: job.style.customer.config },
            prodSpec: { outputs: prodSpec.outputs, columnMapping: prodSpec.columnMapping },
          })
        : []
      )
        .filter((r) => r.ready)
        .map((r) => r.variantKey),
    );
    const next: ProdSpecOutput[] = [];
    for (const o of outputs) {
      if (!want.has(o.variantKey)) continue;
      if (!readyKeys.has(o.variantKey)) {
        await db.log.create({
          data: {
            jobId: job.id,
            level: "WARN",
            message: `skipping output ${o.variantKey}: its required fields are no longer all present`,
          },
        });
        continue;
      }
      next.push(o);
    }
    outputs = next;
  }

  type Generated = {
    variant: TemplateVariant;
    output: ProdSpecOutput;
    fileName: string;
    pdf: Buffer;
  };
  const generated: Generated[] = [];
  for (const output of outputs) {
    const variant = resolveOutputVariant(output);
    if (!variant) {
      // Unknown variant — happens when a registered variant gets removed
      // from code but old ProdSpec rows still reference its key. Log and
      // skip rather than fail the whole job.
      await db.log.create({
        data: {
          jobId: job.id,
          level: "WARN",
          message: `skipping output: variant "${output.variantKey}" not in registry`,
        },
      });
      continue;
    }
    try {
      // Static-pdf passthrough variants emit their source artwork bytes
      // verbatim; everything else renders HTML → PDF.
      const pdf = variant.staticPdf
        ? await variant.staticPdf()
        : await renderPdf({
            html: await variant.render(styleData, {
              widthMm: output.widthMm,
              heightMm: output.heightMm,
            }),
          });
      generated.push({
        variant,
        output,
        fileName: fileNameFor(variant, styleData.styleNumber),
        pdf,
      });
    } catch (err) {
      const reason = (err as Error).message;
      const tag = reason.toLowerCase().includes("barcode") ? "BARCODE_FAILED" : "RENDER_FAILED";
      throw new RunnerError(tag, `${variant.key} render failed: ${reason}`);
    }
  }

  if (generated.length === 0) {
    // Three different reasons we land here — give the operator the right
    // next-action for each:
    //   (a) Style not linked to any ProdSpec     → set BusinessArea on the Style
    //   (b) ProdSpec exists but outputs is empty → add variants on /prod-specs/<id>
    //   (c) ProdSpec has outputs, all disabled / unknown variant keys
    const reason = (() => {
      if (!prodSpec) {
        return (
          "Style has no ProdSpec linked — likely missing a Business Area. " +
          "Edit the Style and set both Customer and Business Area; the ProdSpec is auto-matched by that pair."
        );
      }
      const prodSpecOutputs = Array.isArray(prodSpec.outputs) ? prodSpec.outputs : [];
      if (prodSpecOutputs.length === 0) {
        return (
          `ProdSpec "${prodSpec.name}" has no Outputs configured — open ` +
          `/prod-specs/${prodSpec.id} and use '+ Add output' to pick variants like care-label-01 / care-label-02.`
        );
      }
      return (
        `ProdSpec "${prodSpec.name}" has ${prodSpecOutputs.length} output(s) but all are disabled ` +
        `or reference unknown variant keys — check the Outputs section in /prod-specs/${prodSpec.id}.`
      );
    })();
    throw new RunnerError("NO_OUTPUTS", reason);
  }

  try {
    await db.$transaction([
      db.jobAsset.deleteMany({ where: { jobId: job.id } }),
      ...generated.map((doc) =>
        db.jobAsset.create({
          data: {
            jobId: job.id,
            docType: doc.variant.docType,
            variantKey: doc.variant.key,
            displayName: `${doc.variant.name} · ${doc.output.widthMm}×${doc.output.heightMm} mm`,
            fileName: doc.fileName,
            pdf: toPlainBytes(doc.pdf),
          },
        }),
      ),
      db.job.update({
        where: { id: job.id },
        data: { status: "AWAITING_REVIEW", finishedAt: new Date() },
      }),
      db.style.update({
        where: { id: job.styleId },
        data: { status: "AWAITING_REVIEW" },
      }),
      db.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message: `generated ${generated.length} documents (${generated.map((d) => d.variant.key).join(", ")})`,
        },
      }),
    ]);
  } catch (err) {
    throw new RunnerError("PERSIST_FAILED", `persisting assets failed: ${(err as Error).message}`);
  }

  await notifyReviewer(
    job.id,
    job.styleId,
    job.style.name,
    styleData.styleNumber,
    job.style.customer.name,
    generated.length,
  );
}

async function notifyReviewer(
  jobId: string,
  styleId: string,
  styleName: string,
  styleNumber: string,
  customerName: string,
  documentCount: number,
): Promise<void> {
  const recipient = process.env.REVIEW_NOTIFICATION_EMAIL;
  if (!recipient) return;

  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  const reviewUrl = `${base}/styles/${styleId}/review`;
  const email = reviewNotificationEmail({ styleName, styleNumber, customerName, reviewUrl, documentCount });

  try {
    const result = await sendEmail({ to: recipient, subject: email.subject, html: email.html, text: email.text });
    await db.log.create({
      data: {
        jobId,
        level: "INFO",
        message: result.sent ? `review notification sent to ${recipient}` : "review notification skipped (Resend not configured)",
      },
    });
  } catch (err) {
    await db.log.create({
      data: { jobId, level: "WARN", message: `review notification failed: ${(err as Error).message}` },
    });
  }
}

async function markFailed(jobId: string, error: string): Promise<void> {
  // Print to stderr too — `next dev` only shows the prisma query stream by
  // default, so otherwise the actual exception never reaches the terminal.
  console.error(`[runner] job ${jobId} FAILED: ${error}`);
  await db.job.update({
    where: { id: jobId },
    data: { status: "FAILED", error, finishedAt: new Date() },
  });
  await db.log.create({ data: { jobId, level: "ERROR", message: `job failed: ${error}` } });
}

export class RunnerError extends Error {
  constructor(public readonly tag: string, message: string) {
    super(`[${tag}] ${message}`);
    this.name = "RunnerError";
  }
}

function fileNameFor(variant: TemplateVariant, styleNumber: string): string {
  const slug = styleNumber.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  return `${slug}-${variant.key}.pdf`;
}

// Safely coerce ProdSpec.careInstructionsByLang JSON into a flat
// { langCode: string } map. Invalid shapes return {} so the template
// can render with no care text rather than crash.
function parseCareInstructions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v;
  }
  return out;
}

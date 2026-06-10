import { db } from "@/lib/db";
import { renderPdf } from "@/lib/pdf/renderer";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildStyleData } from "@/lib/styles/render-context";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { applyFieldOverrides } from "@/lib/pdf/pins";
import { countPlaceholderMarkers } from "@/lib/pdf/placeholders";
import type { StyleData } from "@/lib/pdf/types";
import type { TemplateVariant } from "@/lib/pdf/template-registry";
import { dispatchEmail } from "@/lib/email/dispatch";
import { reviewNotificationEmail } from "@/lib/email/templates/review-notification";
import { getReviewNotificationEmails } from "@/lib/settings/app-settings";
import type { TriggerSource } from "@/generated/prisma/enums";
import { parseCustomerConfig } from "@/lib/customers/config";
import {
  DEFAULT_OUTPUTS,
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
  // Load published Output Builder layouts into the variant registry so
  // `layout:<id>` keys resolve like any code-registered variant below
  // (resolveOutputVariant / outputReadinessForStyle are sync lookups).
  await ensureLayoutVariantsLoaded();

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      style: {
        include: {
          customer: true,
          qrImage: true,
          supplier: { select: { country: true } },
          // Display name for the review-ready email (falls back to the
          // free-text Style.businessArea when the mirror row isn't linked).
          businessAreaRef: { select: { name: true } },
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

  let styleData: StyleData;
  try {
    // One shared assembly for runner AND previews — fallback injection,
    // mapping priority (ProdSpec override → Customer config → manual ids),
    // per-ProdSpec context, wash-token repair. See
    // src/lib/styles/render-context.ts for the full resolution rules.
    styleData = await buildStyleData(
      {
        rawData: job.style.rawData,
        poNumber: job.style.poNumber,
        cartonEan: job.style.cartonEan,
        mondayBoardId: job.style.mondayBoardId,
        supplier: job.style.supplier,
        eans: job.style.eans,
        customer: { name: job.style.customer.name, config: job.style.customer.config },
        qrImage: job.style.qrImage ? { image: job.style.qrImage.image } : null,
      },
      prodSpec,
      config,
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
    // Placeholder artifacts (missing artwork tiles / "No carton EAN") found
    // in the rendered HTML — review-safe, blocks approval. 0 for static PDFs.
    placeholderCount: number;
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
      // Per-output pins ("customerName is ALWAYS …") applied on a copy —
      // the base StyleData is shared across this job's outputs.
      const renderStyle = applyFieldOverrides(styleData, output.fieldOverrides);
      // Static-pdf passthrough variants emit their source artwork bytes
      // verbatim; everything else renders HTML → PDF.
      let pdf: Buffer;
      let placeholderCount = 0;
      if (variant.staticPdf) {
        pdf = await variant.staticPdf();
      } else {
        const html = await variant.render(renderStyle, {
          widthMm: output.widthMm,
          heightMm: output.heightMm,
        });
        placeholderCount = countPlaceholderMarkers(html);
        pdf = await renderPdf({ html });
      }
      generated.push({
        variant,
        output,
        fileName: variant.fileNameFor?.(renderStyle) ?? fileNameFor(variant, styleData.styleNumber),
        pdf,
        placeholderCount,
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
            placeholderCount: doc.placeholderCount,
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

  await notifyReviewer({
    jobId: job.id,
    styleId: job.styleId,
    styleName: job.style.name,
    styleNumber: styleData.styleNumber,
    customerName: job.style.customer.name,
    businessArea: job.style.businessAreaRef?.name ?? job.style.businessArea ?? null,
    poNumber: job.style.poNumber ?? null,
    triggerSource: job.triggerSource,
    outputNames: generated.map(
      (d) => `${d.variant.name} · ${d.output.widthMm}×${d.output.heightMm} mm`,
    ),
  });
}

async function notifyReviewer(input: {
  jobId: string;
  styleId: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  triggerSource: TriggerSource;
  outputNames: string[];
}): Promise<void> {
  // Ticket-driven runs stay silent: TICKET_RERUN is the admin iterating on
  // a fix (the reviewer must not be pinged per attempt) and TICKET_FIX
  // sends its own dedicated "fixed — ready for re-review" email from the
  // fix endpoint, with the rejection context the generic mail lacks.
  if (input.triggerSource === "TICKET_RERUN" || input.triggerSource === "TICKET_FIX") return;

  const recipients = await getReviewNotificationEmails();
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  const reviewUrl = `${base}/styles/${input.styleId}/review`;
  const email = reviewNotificationEmail({
    styleName: input.styleName,
    styleNumber: input.styleNumber,
    customerName: input.customerName,
    businessArea: input.businessArea,
    poNumber: input.poNumber,
    reviewUrl,
    outputNames: input.outputNames,
  });

  try {
    // Empty recipients still dispatch: that records a SKIPPED email_logs
    // row with an actionable note instead of silently notifying no one.
    const outcome = await dispatchEmail({
      type: "REVIEW_READY",
      to: recipients,
      subject: email.subject,
      html: email.html,
      text: email.text,
      jobId: input.jobId,
      styleId: input.styleId,
    });
    const message =
      outcome.status === "SENT"
        ? `review notification sent to ${outcome.to}`
        : outcome.status === "SIMULATED"
          ? `review notification SIMULATED (RESEND_EMAILS off) — would go to ${outcome.to}`
          : outcome.status === "FAILED"
            ? `review notification FAILED: ${outcome.note ?? "Resend error"}`
            : `review notification skipped: ${outcome.note ?? "no recipient — set it at /settings/notifications"}`;
    await db.log.create({
      data: { jobId: input.jobId, level: outcome.status === "FAILED" ? "WARN" : "INFO", message },
    });
  } catch (err) {
    await db.log.create({
      data: { jobId: input.jobId, level: "WARN", message: `review notification failed: ${(err as Error).message}` },
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

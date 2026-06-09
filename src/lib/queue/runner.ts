import { db } from "@/lib/db";
import { generateDoc } from "@/lib/pdf/generate";
import { mapMondayItemToStyleData } from "@/lib/pdf/mapper";
import type { MondayItem } from "@/lib/monday/client";
import { sendEmail } from "@/lib/email/client";
import { reviewNotificationEmail } from "@/lib/email/templates/review-notification";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getColumnConfig } from "@/lib/monday/column-config";
import type { DocType } from "@/generated/prisma/enums";

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
    include: { style: { include: { customer: true } } },
  });

  await db.log.create({ data: { jobId: job.id, level: "INFO", message: "job started" } });

  let config: ReturnType<typeof parseCustomerConfig>;
  try {
    config = parseCustomerConfig(job.style.customer.config);
  } catch (err) {
    throw new RunnerError("CONFIG_INVALID", `customer config invalid: ${(err as Error).message}`);
  }

  // Column mapping is shared across all customers.
  const columnConfig = await getColumnConfig();

  let styleData: ReturnType<typeof mapMondayItemToStyleData>;
  try {
    const item = job.style.rawData as unknown as MondayItem;
    styleData = mapMondayItemToStyleData(item, job.style.customer.name, columnConfig.columnMapping);
  } catch (err) {
    throw new RunnerError("MAPPING_FAILED", `monday → style data mapping failed: ${(err as Error).message}`);
  }

  const docTypes = config.enabledDocTypes.length > 0 ? config.enabledDocTypes : (["WASHCARE", "STICKER", "CARTON_MARKING", "COLOUR_STICKER"] as DocType[]);

  const generated: Array<{ docType: DocType; fileName: string; pdf: Buffer }> = [];
  for (const docType of docTypes) {
    try {
      const doc = await generateDoc(docType, styleData);
      generated.push(doc);
    } catch (err) {
      const reason = (err as Error).message;
      const tag = reason.toLowerCase().includes("barcode") ? "BARCODE_FAILED" : "RENDER_FAILED";
      throw new RunnerError(tag, `${docType} render failed: ${reason}`);
    }
  }

  try {
    await db.$transaction([
      db.jobAsset.deleteMany({ where: { jobId: job.id } }),
      ...generated.map((doc) =>
        db.jobAsset.create({
          data: {
            jobId: job.id,
            docType: doc.docType,
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
          message: `generated ${generated.length} documents (${generated.map((d) => d.docType).join(", ")})`,
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

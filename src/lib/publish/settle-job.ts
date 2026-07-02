import { db } from "@/lib/db";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import {
  publishApprovedJob,
  PublishError,
  stampReviewEnded,
} from "@/lib/publish/publish-approved-job";
import { ignoreBaseKey, loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";

export type SettleResult = {
  ok: true;
  settled?: "APPROVED" | "REJECTED";
  // Present when the roll-up published (settled === "APPROVED").
  uploadedCount?: number;
  folderUrl?: string | null;
  notification?: unknown;
  email?: unknown;
  // Publish blew up (e.g. SharePoint outage). The job stays
  // AWAITING_REVIEW so "Approve all & publish" can retry it.
  publishError?: string;
};

// If every asset under a job has been decided, roll the job up.
// All approved → publish (statuses flip inside publishApprovedJob).
// Any rejected → REJECTED.
//
// Ignore-aware: assets of outputs the operator ignored for this style don't
// hold the review open — they count as decided (they'll never be published),
// so ignoring the LAST pending output settles the job exactly like a decision
// would. A job whose every asset is ignored settles APPROVED with nothing
// uploaded — same shape as an all-excluded run.
//
// Shared by the per-asset approve route and the per-asset ignore route (both
// can decide the last open output).
export async function maybeSettleJob(jobId: string, userId: string): Promise<SettleResult> {
  // omit reviewEndedAt — written via stampReviewEnded, never read; tolerates
  // the additive column not being deployed yet.
  const job = await db.job.findUnique({ where: { id: jobId }, omit: { reviewEndedAt: true } });
  if (!job || job.status === "APPROVED" || job.status === "REJECTED") return { ok: true };

  const assets = await db.jobAsset.findMany({
    where: { jobId },
    select: { reviewStatus: true, variantKey: true, docType: true },
  });
  if (assets.length === 0) return { ok: true };

  const ignored = await loadIgnoredOutputKeys(job.styleId);
  const considered =
    ignored.size === 0
      ? assets
      : assets.filter((a) => !ignored.has(ignoreBaseKey(a.variantKey, a.docType)));
  const stillPending = considered.some((a) => a.reviewStatus === "PENDING_REVIEW");
  if (stillPending) return { ok: true };

  const allApproved = considered.every((a) => a.reviewStatus === "APPROVED");

  if (allApproved) {
    await db.log.create({
      data: { jobId, level: "INFO", message: "all assets approved — publishing (upload + supplier email)" },
    });
    try {
      const result = await publishApprovedJob(jobId, userId);
      return {
        ok: true,
        settled: "APPROVED",
        uploadedCount: result.uploaded.length,
        folderUrl: result.folderUrl,
        notification: result.notification,
        email: result.email,
      };
    } catch (err) {
      const message = err instanceof PublishError ? err.message : (err as Error).message;
      await db.log.create({
        data: {
          jobId,
          level: "WARN",
          message: `publish after roll-up failed: ${message} — job stays AWAITING_REVIEW, retry via "Approve all & publish"`,
        },
      });
      return { ok: true, publishError: message };
    }
  }

  await db.job.update({
    where: { id: jobId },
    data: { status: "REJECTED", finishedAt: new Date() },
  });
  await db.style.update({
    where: { id: job.styleId },
    data: { status: "REJECTED" },
  });
  await db.log.create({
    data: { jobId, level: "INFO", message: "asset(s) rejected — job rolled up to REJECTED" },
  });
  // The review just ended (rejected) — stamp reviewEndedAt at the settle seam.
  await stampReviewEnded(jobId);
  // Settled — open dashboard notifications for this job are done. (The
  // approved branch resolves inside publishApprovedJob.)
  await resolveNotificationsForJob(jobId);
  return { ok: true, settled: "REJECTED" };
}

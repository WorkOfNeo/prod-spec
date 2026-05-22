// Fire-and-forget call to the job runner endpoint. The runner is idempotent
// and concurrency-safe (FOR UPDATE SKIP LOCKED), so multiple triggers in a
// short window are fine.
export async function triggerRunner(): Promise<void> {
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "");
  const secret = process.env.JOB_RUNNER_SECRET;
  if (!base || !secret) {
    console.warn("[queue] triggerRunner skipped — PROD_SPEC_BASE_URL or JOB_RUNNER_SECRET not set");
    return;
  }
  void fetch(`${base}/api/jobs/run?secret=${encodeURIComponent(secret)}`, {
    method: "POST",
  }).catch((err) => {
    console.error("[queue] triggerRunner failed", err);
  });
}

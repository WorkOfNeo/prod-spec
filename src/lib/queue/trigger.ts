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

// Fire-and-forget kick for the PO→EAN resolution runner. Same trust boundary
// and idempotency guarantees as triggerRunner — the EAN runner claims PENDING
// styles with FOR UPDATE SKIP LOCKED, so overlapping triggers are harmless.
// The Railway cron is the backstop if this fire-and-forget POST is dropped.
export async function triggerEanRunner(): Promise<void> {
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "");
  const secret = process.env.JOB_RUNNER_SECRET;
  if (!base || !secret) {
    console.warn("[queue] triggerEanRunner skipped — PROD_SPEC_BASE_URL or JOB_RUNNER_SECRET not set");
    return;
  }
  void fetch(`${base}/api/po-eans/run?secret=${encodeURIComponent(secret)}`, {
    method: "POST",
  }).catch((err) => {
    console.error("[queue] triggerEanRunner failed", err);
  });
}

// Fire-and-forget kick for the translations dictionary auto-sync. Fired from
// the Monday Translations-board webhook so a changed phrase refreshes the
// dictionary without running the heavy sink+transform inline. The endpoint
// coalesces (src/lib/monday/translations-auto-sync.ts), so a burst of cell
// edits collapses into at most one in-flight sink plus a trailing catch-up —
// overlapping kicks are harmless, same as triggerRunner.
export async function triggerTranslationsSync(): Promise<void> {
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "");
  const secret = process.env.JOB_RUNNER_SECRET;
  if (!base || !secret) {
    console.warn("[queue] triggerTranslationsSync skipped — PROD_SPEC_BASE_URL or JOB_RUNNER_SECRET not set");
    return;
  }
  void fetch(`${base}/api/admin/translations/sync?secret=${encodeURIComponent(secret)}`, {
    method: "POST",
  }).catch((err) => {
    console.error("[queue] triggerTranslationsSync failed", err);
  });
}

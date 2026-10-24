// =====================================================
// Change requests — the cron sweep hook.
//
// Runs on every cron tick (POST /api/jobs/run?sweep=1, see scripts/cron-tick.mjs):
//   - an agent run that made no progress for 20 minutes is marked FAILED so the
//     request shows a "Run again" button instead of spinning forever;
//   - an output waiting for a new variable (NEEDS_CODE) whose token is now in
//     the catalogue — the deploy that added it is live — is picked up again.
// Fail-soft and
// a no-op while CHANGE_REQUESTS_ENABLED is off, so the PDF pipeline the same
// tick drives can never be held up by this.
// =====================================================

import { changeRequestsEnabled } from "./flags";
import { failStaleRuns, startChangeRequestRun } from "./agent/job";

export async function changeRequestSweep(): Promise<{ failed: number; resumed: number } | null> {
  if (!changeRequestsEnabled()) return null;
  let failed = 0;
  let resumed = 0;
  try {
    failed = (await failStaleRuns()).failed.length;
  } catch (err) {
    console.warn("[change-requests] stale-run sweep failed:", err);
  }
  try {
    const { resumeAwaitingCode } = await import("./gap");
    const ids = await resumeAwaitingCode((outputId) => startChangeRequestRun(outputId, { trigger: "resume", userId: null }));
    resumed = ids.length;
  } catch (err) {
    console.warn("[change-requests] resume sweep failed:", err);
  }
  return { failed, resumed };
}

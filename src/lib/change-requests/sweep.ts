// =====================================================
// Change requests — the cron sweep hook.
//
// Runs on every cron tick (POST /api/jobs/run?sweep=1, see scripts/cron-tick.mjs):
// an agent run that made no progress for 20 minutes is marked FAILED so the
// request shows a "Run again" button instead of spinning forever. Fail-soft and
// a no-op while CHANGE_REQUESTS_ENABLED is off, so the PDF pipeline the same
// tick drives can never be held up by this.
// =====================================================

import { changeRequestsEnabled } from "./flags";
import { failStaleRuns } from "./agent/job";

export async function changeRequestSweep(): Promise<{ failed: number } | null> {
  if (!changeRequestsEnabled()) return null;
  try {
    const { failed } = await failStaleRuns();
    return { failed: failed.length };
  } catch (err) {
    console.warn("[change-requests] sweep failed:", err);
    return null;
  }
}

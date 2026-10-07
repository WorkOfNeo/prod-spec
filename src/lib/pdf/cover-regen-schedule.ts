import { getCoverRegenQueue, updateCoverRegenQueue } from "@/lib/settings/app-settings";
import { dueStyleIds, rearmFailed, withoutDue, type CoverRegenQueue } from "@/lib/pdf/cover-regen-ledger";
import { processCoverRefreshChunk } from "@/lib/pdf/cover-regen-sweep";
import { maybeEnqueueCoverRun } from "@/lib/queue/generation-sweep";
import { triggerRunner } from "@/lib/queue/trigger";

// =====================================================
// Automatic, debounced cover refresh. Every output approval/rejection stamps
// its style into a debounce ledger (dueAt = now + DEBOUNCE_MS); a burst of
// per-output decisions within the window collapses to ONE cover regen fired
// after the LAST decision, instead of a puppeteer render per click.
//
// The regen is driven two ways, both idempotent and both calling the same
// drain:
//   • a best-effort in-process timer, re-armed on each decision, for snappy
//     (~DEBOUNCE_MS) latency on the normal single-instance server, and
//   • the /api/cron/cover-regen backstop, which drains anything the timer
//     missed (process restart / deploy / a second instance). The DB ledger is
//     the durable source of truth; the timer is only an accelerator.
//
// The regen itself reuses the sweep's per-style path (refresh the cover in
// place → re-arm the supplier-send queue → push to SharePoint), so an approved
// style ends with the current cover in the app AND in the supplier folder.
// =====================================================

// How long to wait after the last decision before regenerating. A touch above
// the ~5s "approve, approve, approve" burst so rapid decisions coalesce.
export const DEBOUNCE_MS = 8000;

// ---- In-process fast path --------------------------------------------------

// styleId → pending timer. Module-scoped: persists across requests in the warm
// server process. Best-effort only — the cron backstop is the guarantee.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function armTimer(styleId: string): void {
  const existing = timers.get(styleId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(styleId);
    // Drain whatever is due now (this style plus any sibling that came due).
    void runDueCoverRegens().catch((err) =>
      console.warn(`[cover-regen] timer drain failed:`, err),
    );
  }, DEBOUNCE_MS + 500);
  // Never keep the process alive just for this timer.
  if (typeof t.unref === "function") t.unref();
  timers.set(styleId, t);
}

// ---- Public API ------------------------------------------------------------

// Record demand for a style's cover to be refreshed after the debounce window.
// Called on every output approval/rejection. Fail-soft: a ledger hiccup must
// never break the decision that triggered it. Awaited so the durable demand is
// recorded before the request returns (the cron can then always catch it, even
// if the in-process timer is lost to a restart).
export async function scheduleCoverRegen(styleId: string): Promise<void> {
  try {
    // A fresh decision is fresh demand: a plain entry, attempt count reset.
    const dueAt = new Date(Date.now() + DEBOUNCE_MS).toISOString();
    await updateCoverRegenQueue((queue) => ({ queue: { ...queue, [styleId]: dueAt }, result: null }));
  } catch (err) {
    console.warn(`[cover-regen] schedule failed for ${styleId}:`, err);
  }
  armTimer(styleId);
}

export type CoverRegenDrainResult = {
  processed: number;
  refreshed: number;
  noCover: number;
  // no-cover styles handed to a generation run so they get their FIRST cover.
  coverRuns: number;
  pushed: number;
  errors: number;
};

// Regenerate + deliver the cover of every style whose debounce window has
// elapsed. Claims the due styles (removes them from the ledger) BEFORE
// rendering, so a concurrent timer/cron can't double-bill them. Idempotent
// either way — the refresh overwrites the cover bytes and the enqueue upserts —
// so a claim race at worst wastes one render. Reuses the sweep's per-style path
// (refresh in place → re-arm supplier queue → push to SharePoint).
export async function runDueCoverRegens(): Promise<CoverRegenDrainResult> {
  const empty: CoverRegenDrainResult = {
    processed: 0,
    refreshed: 0,
    noCover: 0,
    coverRuns: 0,
    pushed: 0,
    errors: 0,
  };

  // Claim: take the due entries out of the ledger in the same locked
  // transaction that reads them, so nothing stamped concurrently is erased.
  const now = Date.now();
  const claimed = await updateCoverRegenQueue((queue) => {
    const taken: CoverRegenQueue = {};
    for (const styleId of dueStyleIds(queue, now)) taken[styleId] = queue[styleId];
    return { queue: withoutDue(queue, now), result: taken };
  });
  const due = Object.keys(claimed);
  if (due.length === 0) return empty;

  try {
    // Deliberately NOT onlyPending. The bulk sweep skips all-approved styles
    // (a rebuild there is visually a no-op that still overwrites a finished
    // order's file), but this path is event-driven: it fires BECAUSE an output
    // was just approved or rejected. The approval that makes a style fully
    // approved is exactly the one whose cover must be re-rendered — to drop the
    // Status column and show a clean all-Approved manifest. Skip it here and
    // the supplier's copy would be frozen showing pending rows forever.
    // trigger "content": this drain fires BECAUSE an output of this style was
    // just approved or rejected. That is the style's own facts moving, so the
    // supplier hears about it in tonight's digest exactly as they always have —
    // and it is also what re-arms a style the wording sweep had silenced.
    const { outcomes, pushed } = await processCoverRefreshChunk(due, {
      deliver: true,
      trigger: "content",
    });
    const failed = outcomes.filter((o) => o.status === "error");
    for (const o of failed) {
      console.warn(`[cover-regen] cover render failed for ${o.styleId}:`, "error" in o ? o.error : "");
    }
    // A per-style failure is retried rather than dropped — the claim already
    // took it out of the ledger, so without this nothing would ever rebuild it.
    if (failed.length > 0) await rearm(failed.map((o) => o.styleId), claimed);
    const noCover = outcomes.filter((o) => o.status === "no-cover").map((o) => o.styleId);
    const coverRuns = await enqueueFirstCovers(noCover);
    return {
      processed: due.length,
      refreshed: outcomes.filter((o) => o.status === "refreshed").length,
      noCover: noCover.length,
      coverRuns,
      pushed,
      errors: failed.length,
    };
  } catch (err) {
    // Catastrophic drain failure (not a per-style error — those are handled
    // above). Put the claimed styles back so a later tick retries them.
    console.warn(`[cover-regen] drain failed, re-arming ${due.length} style(s):`, err);
    await rearm(due, claimed);
    return { ...empty, errors: due.length };
  }
}

// The failsafe for "a packaging line changed, but there is no cover to
// rebuild". The refresh path only rewrites an EXISTING cover in place, and a
// cover is only ever built by a generation run — so a style whose first run
// never happened (no output ready yet, or a cover-only spec with none at all)
// used to drop out here as "no-cover" and stay without one. A manual
// upload or approval is demand for the cover, so hand those styles to a run:
// it renders the ready outputs (none, for a cover-only spec) and builds the
// cover with the manifest as it stands now. Bounded — the gate closes once the
// cover exists, and it stops after repeated failures. Best-effort per style.
async function enqueueFirstCovers(styleIds: string[]): Promise<number> {
  let enqueued = 0;
  for (const styleId of styleIds) {
    try {
      const r = await maybeEnqueueCoverRun(styleId, "CRON_SWEEP");
      if (r.enqueued) enqueued += 1;
      else console.info(`[cover-regen] ${styleId} has no cover and no run was queued: ${r.reason}`);
    } catch (err) {
      console.warn(`[cover-regen] could not queue a cover run for ${styleId}:`, err);
    }
  }
  if (enqueued > 0) await triggerRunner();
  return enqueued;
}

// Put failed styles back in the ledger with a backoff (see rearmFailed).
// Best-effort: a ledger hiccup here is logged, never thrown over the drain.
async function rearm(styleIds: string[], claimed: CoverRegenQueue): Promise<void> {
  try {
    const gaveUp = await updateCoverRegenQueue((queue) => {
      const r = rearmFailed(queue, styleIds, claimed, Date.now());
      return { queue: r.queue, result: r.gaveUp };
    });
    for (const styleId of gaveUp) {
      console.warn(`[cover-regen] giving up on ${styleId} after repeated render failures`);
    }
  } catch (err) {
    console.warn(`[cover-regen] could not re-arm ${styleIds.length} style(s):`, err);
  }
}

// Is a cover rebuild for this style still waiting in the ledger? Lets the
// review panel tell "queued, give it a moment" apart from "done".
export async function isCoverRegenPending(styleId: string): Promise<boolean> {
  try {
    return styleId in (await getCoverRegenQueue());
  } catch {
    return false;
  }
}

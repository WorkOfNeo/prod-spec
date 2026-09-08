import { getCoverRegenQueue, setCoverRegenQueue } from "@/lib/settings/app-settings";
import { dueStyleIds, withoutDue } from "@/lib/pdf/cover-regen-ledger";
import { processCoverRefreshChunk } from "@/lib/pdf/cover-regen-sweep";

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
    const queue = await getCoverRegenQueue();
    queue[styleId] = new Date(Date.now() + DEBOUNCE_MS).toISOString();
    await setCoverRegenQueue(queue);
  } catch (err) {
    console.warn(`[cover-regen] schedule failed for ${styleId}:`, err);
  }
  armTimer(styleId);
}

export type CoverRegenDrainResult = {
  processed: number;
  refreshed: number;
  noCover: number;
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
    pushed: 0,
    errors: 0,
  };

  const now = Date.now();
  const queue = await getCoverRegenQueue();
  const due = dueStyleIds(queue, now);
  if (due.length === 0) return empty;

  // Claim: persist the ledger without the due entries.
  await setCoverRegenQueue(withoutDue(queue, now));

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
    return {
      processed: due.length,
      refreshed: outcomes.filter((o) => o.status === "refreshed").length,
      noCover: outcomes.filter((o) => o.status === "no-cover").length,
      pushed,
      errors: outcomes.filter((o) => o.status === "error").length,
    };
  } catch (err) {
    // Catastrophic drain failure (not a per-style error — those are captured in
    // outcomes). Put the claimed styles back so the next cron tick retries them.
    console.warn(`[cover-regen] drain failed, re-arming ${due.length} style(s):`, err);
    try {
      const current = await getCoverRegenQueue();
      const retryAt = new Date(Date.now() + DEBOUNCE_MS).toISOString();
      for (const styleId of due) if (!current[styleId]) current[styleId] = retryAt;
      await setCoverRegenQueue(current);
    } catch {
      /* best-effort */
    }
    return { ...empty, errors: due.length };
  }
}

import { sinkBoard } from "@/lib/monday/sink";
import { syncTranslations } from "@/lib/monday/translations";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { getTranslationSyncState, setTranslationSyncState } from "@/lib/settings/app-settings";
import { triggerTranslationsSync } from "@/lib/queue/trigger";

// A crashed run must not wedge auto-sync forever: a `runningAt` older than this
// is treated as stale (the process died mid-sink) and the slot is re-claimable.
const RUN_STALE_MS = 10 * 60 * 1000;

function isoNow(): string {
  return new Date().toISOString();
}

function runIsActive(runningAt: string, now: number): boolean {
  if (!runningAt) return false;
  const started = Date.parse(runningAt);
  return Number.isFinite(started) && now - started < RUN_STALE_MS;
}

export type AutoSyncOutcome =
  // Another run is in flight; it will pick up this demand before it finishes.
  | { status: "coalesced" }
  // This call ran the sink + transform, covering everything requested up to now.
  | { status: "synced"; requestedAt: string };

// Coalescing entry point for the AUTOMATIC translations refresh, called by the
// Monday Translations-board webhook via a fire-and-forget kick to the sync
// route. Because Monday fires one `change_column_value` event per edited cell,
// running a full board re-sink per event would hammer Monday and the DB. This
// records demand, then claims and drains: a run covers everything requested up
// to its start, and if new demand arrived while it ran, one more run is kicked.
// A burst of edits therefore collapses to ~one in-flight sink plus a trailing
// catch-up rather than one re-sink per cell.
//
// Overlapping runs are harmless — sinkBoard/syncTranslations are idempotent
// upserts, the same guarantee triggerRunner relies on — so the claim need not
// be perfectly atomic; the stale timeout and the trailing re-kick keep it
// converging on the board's latest state.
export async function autoSyncTranslations(): Promise<AutoSyncOutcome> {
  // 1. Record demand so an active run (or a follow-up kick) covers this edit.
  const requestedAt = isoNow();
  const demandState = await getTranslationSyncState();
  await setTranslationSyncState({ ...demandState, requestedAt });

  // 2. Try to claim the run slot. If a fresh run already holds it, that run's
  //    trailing check will see our bumped requestedAt and drain us.
  const claim = await getTranslationSyncState();
  if (runIsActive(claim.runningAt, Date.now())) {
    return { status: "coalesced" };
  }
  await setTranslationSyncState({ ...claim, runningAt: isoNow() });

  // 3. Run the sink + transform. `covered` is the demand high-water mark this
  //    run is responsible for — anything requested after it is left to step 4.
  const covered = requestedAt;
  try {
    await sinkBoard(MONDAY_BOARDS.translations);
    await syncTranslations();
  } finally {
    // Release the slot whether we succeeded or threw, so a later kick can run.
    const done = await getTranslationSyncState();
    await setTranslationSyncState({ ...done, runningAt: "" });
  }

  // 4. If new demand slipped in while we ran (or during the release window),
  //    drain it with one more kick. Bounded: requestedAt only advances on a
  //    genuine new webhook, so a single edit never re-kicks itself.
  const final = await getTranslationSyncState();
  if (final.requestedAt > covered) {
    void triggerTranslationsSync();
  }
  return { status: "synced", requestedAt: covered };
}

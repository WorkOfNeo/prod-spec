// Human labels + automated/manual classification for a Job's TriggerSource.
// Shared so every surface that shows "why did this run fire" — the per-style
// History timeline and the per-ProdSpec run list — agrees on the wording and
// on whether a human asked for the run or the system fired it on its own.
// Also home to the one delivery rule that is a function of the trigger alone
// (coverNotifiesSupplier, below). PURE LEAF — no imports.

export const TRIGGER_LABELS: Record<string, string> = {
  WEBHOOK: "Monday webhook (fields landed)",
  MANUAL_RERUN: "manual re-run",
  ADMIN_TEST: "admin test",
  MANUAL_IMPORT: "import promotion",
  TICKET_RERUN: "rejection-ticket re-run",
  TICKET_FIX: "rejection-ticket fix",
  EAN_RESOLVED: "barcodes landed (EAN handoff)",
  CRON_SWEEP: "backlog sweep",
  MANUAL_BULK: "bulk run",
  CHANGE_REQUEST: "change request",
};

export type TriggerKind = "automated" | "manual";

// A run is "manual" when a human explicitly asked for it (a Re-run / bulk-run
// button, an import promotion, a rejection-ticket action, an admin test, an
// admin approving a change request). It's
// "automated" when the system fired it unprompted: the Monday webhook, the
// PO→EAN handoff, or the backlog cron sweep. Unknown sources default to
// automated (safer to under-claim a human than to falsely attribute one).
const MANUAL_SOURCES = new Set<string>([
  "MANUAL_RERUN",
  "MANUAL_BULK",
  "MANUAL_IMPORT",
  "ADMIN_TEST",
  "TICKET_RERUN",
  "TICKET_FIX",
  "CHANGE_REQUEST",
]);

export function triggerKind(source: string): TriggerKind {
  return MANUAL_SOURCES.has(source) ? "manual" : "automated";
}

export function triggerLabel(source: string): string {
  return TRIGGER_LABELS[source] ?? source.toLowerCase().replace(/_/g, " ");
}

// Does the cover this run re-arms ride tonight's supplier digest? The runner
// re-arms the style's cover on every successful run (requeue-cover.ts); the
// file always goes to the supplier folder, and this decides only whether the
// row also EMAILS. A change-request rerun regenerates documents because an
// admin changed a layout, not because anything about the supplier's order
// moved, and the regenerated documents go back to review before anyone sends
// them — so its cover is re-armed silently (design §2 rail 3). Every other
// trigger notifies, exactly as before. Derived from the trigger alone, so it
// never latches: the next ordinary run re-arms the row to notifying.
export function coverNotifiesSupplier(source: string): boolean {
  return source !== "CHANGE_REQUEST";
}

// Human labels + automated/manual classification for a Job's TriggerSource.
// Shared so every surface that shows "why did this run fire" — the per-style
// History timeline and the per-ProdSpec run list — agrees on the wording and
// on whether a human asked for the run or the system fired it on its own.

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
};

export type TriggerKind = "automated" | "manual";

// A run is "manual" when a human explicitly asked for it (a Re-run / bulk-run
// button, an import promotion, a rejection-ticket action, an admin test). It's
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
]);

export function triggerKind(source: string): TriggerKind {
  return MANUAL_SOURCES.has(source) ? "manual" : "automated";
}

export function triggerLabel(source: string): string {
  return TRIGGER_LABELS[source] ?? source.toLowerCase().replace(/_/g, " ");
}

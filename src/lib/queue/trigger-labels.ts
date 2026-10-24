// Human labels + automated/manual classification for a Job's TriggerSource.
// Shared so every surface that shows "why did this run fire" — the per-style
// History timeline and the per-ProdSpec run list — agrees on the wording and
// on whether a human asked for the run or the system fired it on its own.
// Also home to the rules that are a function of the trigger alone (cover
// notification, auto-approval, fresh layouts, approved documents in a scoped
// run — below). PURE LEAF — no imports.

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
  CHANGE_REQUEST_APPROVED: "change request (approved documents)",
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
  "CHANGE_REQUEST_APPROVED",
]);

export function triggerKind(source: string): TriggerKind {
  return MANUAL_SOURCES.has(source) ? "manual" : "automated";
}

export function triggerLabel(source: string): string {
  return TRIGGER_LABELS[source] ?? source.toLowerCase().replace(/_/g, " ");
}

// The runs a change request starts: the scoped rerun after an approval
// (CHANGE_REQUEST) and the explicit second confirmation that sends approved
// documents back to review (CHANGE_REQUEST_APPROVED). The three guards below
// treat both alike; they differ only in runKeepsApprovedDocuments.
const CHANGE_REQUEST_SOURCES = new Set<string>(["CHANGE_REQUEST", "CHANGE_REQUEST_APPROVED"]);

export function isChangeRequestRun(source: string): boolean {
  return CHANGE_REQUEST_SOURCES.has(source);
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
  return !isChangeRequestRun(source);
}

// May this run auto-approve its documents (layout autoApprove / spec "Fully
// approved")? Not a change-request rerun: those documents exist because an
// admin just changed the layout, so a person looks at the new render before it
// counts as approved — and an auto-approval would also capture it into the
// supplier-send queue (design §2 rail 3). Every other trigger: unchanged.
export function runMayAutoApprove(source: string): boolean {
  return !isChangeRequestRun(source);
}

// Must this run reload published layouts before rendering? A change-request
// rerun is enqueued right after its layout was published; the registry's TTL
// cache could still hold the previous definition (another process, or a load
// that started before the publish committed), so it forces a fresh read.
export function runNeedsFreshLayouts(source: string): boolean {
  return isChangeRequestRun(source);
}

// Must this SCOPED run leave approved documents alone? A scoped job otherwise
// regenerates whatever it names, approved or not (durable approval is only
// enforced on full runs). The automatic rerun after a change-request approval
// must never put an approved document back into review — that takes the
// explicit second confirmation, which runs as CHANGE_REQUEST_APPROVED — so the
// runner drops every scoped base that has ANY approved document right now,
// even if an approval landed between the enqueue and the run (design §2
// rail 3).
export function runKeepsApprovedDocuments(source: string): boolean {
  return source === "CHANGE_REQUEST";
}

// The scope a run keeps after runKeepsApprovedDocuments: base keys (no
// "#suffix") minus every base with an approved document. PURE; order kept.
export function withoutApprovedBases(
  scopedBases: readonly string[],
  approvedBases: ReadonlySet<string>,
): { keep: string[]; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const base of new Set(scopedBases)) (approvedBases.has(base) ? dropped : keep).push(base);
  return { keep, dropped };
}

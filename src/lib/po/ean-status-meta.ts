// Display metadata for StyleEanStatus — shared by the PO barcodes table and
// the Styles list so the badge label + colour are identical everywhere.
// Plain data (no server imports) so it's safe in client components.
export const EAN_STATUS_META: Record<string, { label: string; cls: string }> = {
  NONE: { label: "not queued", cls: "bg-zinc-100 text-zinc-600" },
  PENDING: { label: "queued", cls: "bg-blue-100 text-blue-700" },
  RESOLVING: { label: "resolving…", cls: "bg-blue-100 text-blue-700" },
  RESOLVED: { label: "resolved", cls: "bg-emerald-100 text-emerald-800" },
  RESOLVED_FROM_MONDAY: { label: "resolved (Monday)", cls: "bg-teal-100 text-teal-800" },
  PARTIAL: { label: "partial", cls: "bg-amber-100 text-amber-800" },
  PO_FOUND_NO_EANS: { label: "PO has no barcodes", cls: "bg-orange-100 text-orange-800" },
  PO_NOT_FOUND: { label: "PO not found", cls: "bg-red-100 text-red-700" },
  STYLE_NOT_IN_PO: { label: "style not in PO", cls: "bg-rose-100 text-rose-700" },
  ERROR: { label: "error", cls: "bg-red-100 text-red-700" },
};

export function eanStatusMeta(status: string): { label: string; cls: string } {
  return EAN_STATUS_META[status] ?? { label: status.toLowerCase(), cls: "bg-zinc-100 text-zinc-600" };
}

// Max consecutive non-resolved scrape attempts before a row stops auto-
// retrying and "floats" for manual attention. The retry sweep caps on this
// (src/lib/po/ean-runner.ts) and the /po-eans table surfaces it.
export const MAX_EAN_ATTEMPTS = 3;

// The non-resolved statuses the sweep retries — i.e. the ones that can float
// once attempts run out. Keep in sync with RETRYABLE in ean-runner.ts.
// Exported so server pages can build the same "floated" Prisma filter the
// /automation badge counts with (eanStatus in here + attempts >= MAX).
export const FLOATABLE_STATUSES = [
  "PO_FOUND_NO_EANS",
  "PO_NOT_FOUND",
  // A re-issued PO may add the style later, so retry a few times, then float.
  "STYLE_NOT_IN_PO",
  "ERROR",
] as const;
const FLOATABLE_SET = new Set<string>(FLOATABLE_STATUSES);

// A row has "floated" when it's in a retryable-but-unresolved state and has
// burned its attempt budget — the sweep will no longer pick it up, so a human
// must re-trigger it (the per-row Re-resolve, which resets the counter).
export function eanFloated(status: string, attempts: number): boolean {
  return attempts >= MAX_EAN_ATTEMPTS && FLOATABLE_SET.has(status);
}

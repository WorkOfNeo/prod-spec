// Display metadata for StyleEanStatus — shared by the PO barcodes table and
// the Styles list so the badge label + colour are identical everywhere.
// Plain data (no server imports) so it's safe in client components.
export const EAN_STATUS_META: Record<string, { label: string; cls: string }> = {
  NONE: { label: "not queued", cls: "bg-zinc-100 text-zinc-600" },
  PENDING: { label: "queued", cls: "bg-blue-100 text-blue-700" },
  RESOLVING: { label: "resolving…", cls: "bg-blue-100 text-blue-700" },
  RESOLVED: { label: "resolved", cls: "bg-emerald-100 text-emerald-800" },
  PARTIAL: { label: "partial", cls: "bg-amber-100 text-amber-800" },
  PO_FOUND_NO_EANS: { label: "PO has no barcodes", cls: "bg-orange-100 text-orange-800" },
  PO_NOT_FOUND: { label: "PO not found", cls: "bg-red-100 text-red-700" },
  ERROR: { label: "error", cls: "bg-red-100 text-red-700" },
};

export function eanStatusMeta(status: string): { label: string; cls: string } {
  return EAN_STATUS_META[status] ?? { label: status.toLowerCase(), cls: "bg-zinc-100 text-zinc-600" };
}

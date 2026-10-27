// The /styles table row — what the server ships per style and the browser
// filters, sorts and renders. Client-safe on purpose (types and pure helpers
// only): styles-table.tsx imports it, and list-rows.ts builds it server-side.
//
// Every field here is read by the table. Values the browser can derive itself
// (the search blob) or never reads (the notice ladder, the status pill's tone
// and hint) are left out — at ~4–5k rows each per-row byte is paid thousands
// of times in the page payload.

import type { EffectiveStatus } from "@/lib/styles/effective-status";
import type { ReadinessNotice } from "@/lib/styles/readiness-notice";
import type { SupplierUploadRollup, ReviewRollup } from "@/lib/styles/table-rollups";
// Type-only on purpose: related.ts imports @/lib/db, and only an erased
// `import type` keeps Prisma out of this client bundle.
import type { LookalikeChip } from "@/lib/styles/related";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";

export type StyleListRow = {
  id: string;
  name: string;
  poNumber: string | null;
  // Parsed numeric PO (Style.poSeq) — the DEFAULT SORT KEY. Null when there's
  // no PO or it doesn't parse; those rows sort last. Never sort on poNumber:
  // "C-PO9" beats "C-PO12345" as a string. See @/lib/styles/table-sort.
  poSeq: number | null;
  // Who is reviewing — the reviewer who claimed this style's newest claimed
  // job (Job.reviewClaimedBy). Null = unclaimed. Drives the Reviewer facet,
  // the Reviewer attribute chip and the opt-in Reviewer column.
  reviewerName: string | null;
  // Set when this style's name also exists on another PO's Monday row — the
  // "1 of 2 rows with this name" chip. Null (the common case) renders nothing.
  // Computed server-side in ONE bulk query; see src/lib/styles/related.ts.
  lookalike: LookalikeChip | null;
  customerName: string;
  // Customer.config.skipSupplierDelivery — shows a "Delivers own" chip next
  // to the customer so the row isn't mistaken for one that sends supplier
  // delivery on generation.
  customerDeliversOwn: boolean;
  businessArea: string | null;
  completionPct: number;
  // % of required columns this style must reach before it can generate.
  // From the linked ProdSpec; null when no ProdSpec is linked.
  threshold: number | null;
  hasProdSpec: boolean;
  // Linked AND active — the "Prod spec" chip's "applied" sense. Distinct from
  // hasProdSpec (mere linkage), which the completion column still relies on.
  prodSpecActive: boolean;
  hasSupplier: boolean;
  // Required detail fields filled / total (Settings ▸ Required fields).
  // requiredTotal 0 = none configured.
  requiredFilled: number;
  requiredTotal: number;
  // The computed status (see computeEffectiveStatus()): review flow when
  // PDFs/jobs exist, otherwise the field-readiness ladder. `key` drives the
  // Status facet filter, `label` joins the search blob; the *visible* pill
  // renders `notice`.
  statusView: Pick<EffectiveStatus, "key" | "label">;
  // Cause-aware readiness notice (harder-blocker-wins headline). This is what
  // the Status cell renders via <ReadinessPill>. statusView remains the
  // filtering/sorting key — do not swap that.
  notice: Pick<ReadinessNotice, "headline" | "tone">;
  // The pill's hover text, built server-side from the full notice (see
  // statusTitle) so the step ladder never ships per row.
  statusTitle: string;
  // PO → EAN resolution state (StyleEanStatus). Badge via eanStatusMeta.
  eanStatus: string;
  groupTitle: string | null;
  // Server-computed: hide behind "Show archived". Done/cancelled/archived
  // groups — except Done-group styles re-admitted by the PO cutoff, which
  // stay in the main view (see /styles page query).
  archived: boolean;
  // Manually pulled into the styleboard for layout testing — surfaced via the
  // "Pulled" attribute chip (Settings ▸ Pull style by PO).
  pulledForTest: boolean;
  // Server-computed: no PO number ("Navision Task") on the Monday row. Hidden
  // from the default view — nothing generates without a PO, so these styles
  // haven't entered the flow. Revealed by the "No PO" chip.
  missingPo: boolean;
  lastSyncedAt: string;
  // ── Opt-in columns (hydrated only when the column is visible) ──
  // Identity & links — small, always hydrated.
  supplierName: string | null;
  supplierCountry: string | null;
  prodSpecName: string | null;
  prodSpecId: string | null;
  cartonEan: string | null;
  poFileName: string | null;
  styleFolderUrl: string | null;
  mondayItemId: string | null;
  mondayBoardId: string | null;
  createdAt: string;
  updatedAt: string;
  // SharePoint & delivery.
  folderConnected: boolean;
  supplierFolderUrl: string | null;
  upload: SupplierUploadRollup | null;
  // Spec fields, keyed by column key (only the visible ones are present).
  resolved: Record<string, string>;
  // Review / approval rollup (null unless a review column is on).
  review: ReviewRollup | null;
  // Open rejection-log threads (null unless the Comments column is on).
  comments: { open: number; fixed: number } | null;
};

// The lowercase haystack the search box matches against: name + customer +
// BA + PO# + status + group + EAN status, plus the opt-in supplier / prod spec
// names and the hydrated (visible) spec fields. Built in the browser from the
// row itself rather than shipped — it repeated every one of these values.
export function styleSearchBlob(r: StyleListRow): string {
  return [
    r.name,
    r.customerName,
    r.businessArea ?? "",
    r.poNumber ?? "",
    r.statusView.label,
    r.groupTitle ?? "",
    eanStatusMeta(r.eanStatus).label,
    r.supplierName ?? "",
    r.prodSpecName ?? "",
    ...Object.values(r.resolved),
  ]
    .join(" ")
    .toLowerCase();
}

// Hover text for the status pill: the count (which moves out of the headline
// when a harder blocker wins) plus the top blocking step's detail, so the row
// still explains itself on hover. Falls back to the headline when nothing
// blocks.
export function statusTitle(notice: ReadinessNotice): string {
  const blocking = notice.steps.find((s) => s.tone === "red" || s.tone === "amber");
  const count = notice.total > 0 ? `${notice.ready} of ${notice.total} ready` : null;
  const detail = blocking ? `${blocking.title} — ${blocking.detail}` : notice.headline;
  return count && detail !== count ? `${count}\n${detail}` : detail;
}

// The /styles table row — what the server ships per style and the browser
// filters, sorts and renders. Client-safe on purpose (types only):
// styles-table.tsx imports it, and list-rows.ts builds it server-side.

import type { EffectiveStatus } from "@/lib/styles/effective-status";
import type { ReadinessNotice } from "@/lib/styles/readiness-notice";
import type { SupplierUploadRollup, ReviewRollup } from "@/lib/styles/table-rollups";
// Type-only on purpose: related.ts imports @/lib/db, and only an erased
// `import type` keeps Prisma out of this client bundle.
import type { LookalikeChip } from "@/lib/styles/related";

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
  // The Status pill — computed: review flow when PDFs/jobs exist, otherwise
  // the field-readiness ladder. See computeEffectiveStatus(). Drives the
  // Status facet filter + searchBlob; the *visible* pill now renders `notice`.
  statusView: EffectiveStatus;
  // Cause-aware readiness notice (harder-blocker-wins headline + count). This
  // is what the Status cell renders via <ReadinessPill>. statusView remains the
  // filtering/sorting key — do not swap that.
  notice: ReadinessNotice;
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
  searchBlob: string;
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
};

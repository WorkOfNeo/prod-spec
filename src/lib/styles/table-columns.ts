// Column registry for the /styles table. Single source of truth for what a
// column IS: its key, header label, group, and canonical position — the render
// order in styles-table.tsx is this array filtered by the visible set, so
// "move a column" means reordering here. Which columns are VISIBLE is an
// admin-controlled global setting (AppSetting "stylesTableColumns", see
// src/lib/settings/app-settings.ts) — the standard view every user gets,
// not a per-user preference.
//
// The registry is intentionally large: nearly everything the single-style page
// shows can be a column. To keep the ~4k-row payload small, page.tsx only
// HYDRATES the currently-visible columns (see hydration in styles/page.tsx),
// and the Columns popover refreshes the page when a column is toggled on so its
// data loads. So adding columns here is cheap until they're switched on.

// Groups partition the (long) column list in the Columns popover.
export type StyleColumnGroup = "core" | "identity" | "spec" | "delivery" | "review";

export const STYLE_COLUMN_GROUP_LABELS: Record<StyleColumnGroup, string> = {
  core: "Core",
  identity: "Identity & links",
  spec: "Spec fields",
  delivery: "SharePoint & delivery",
  review: "Review & approval",
};

export const STYLE_COLUMN_GROUP_ORDER: readonly StyleColumnGroup[] = [
  "core",
  "identity",
  "spec",
  "delivery",
  "review",
];

export type StyleColumnKey =
  // core
  | "style"
  | "po"
  | "customer"
  | "businessArea"
  | "group"
  | "generation"
  | "completion"
  | "status"
  | "ean"
  | "lastSynced"
  // identity & links
  | "supplier"
  | "prodSpec"
  | "cartonEan"
  | "poFile"
  | "styleFolder"
  | "monday"
  | "created"
  | "updated"
  // spec fields (resolved from the customer mapping / rawData)
  | "styleNumber"
  | "composition"
  | "composition2"
  | "colourName"
  | "colourCode"
  | "washCare"
  | "sizes"
  | "countryOfOrigin"
  | "cartonQty"
  | "klNumber"
  | "lot"
  | "supplierNumber"
  | "supplierEmail"
  | "price"
  | "productNameTranslations"
  | "certificates"
  | "customerItemNo"
  | "barcodeNumber"
  | "batchNo"
  | "targetGroup"
  | "customerOrderNo"
  | "deliveryTerm"
  | "description"
  | "prodNumber"
  | "campaignWeek"
  | "salesUnit"
  | "trims"
  | "productGroup"
  // SharePoint & delivery
  | "sharepoint"
  | "folderConnected"
  | "approvedFolder"
  | "deliversOwn"
  // review & approval
  | "approved"
  | "fullyApproved"
  | "awaitingReview";

export type StyleColumnDef = {
  key: StyleColumnKey;
  label: string;
  group: StyleColumnGroup;
  // Locked columns can't be hidden — the table needs at least the name link.
  locked?: boolean;
};

// Spec-field columns resolve one mapped field from the style's rawData (via the
// customer's column mapping, supplier/PO/EAN fallbacks included). The column
// KEY equals the ColumnMapping field key, so page.tsx can resolve it generically
// without a per-column branch. This Set is the single source of "is this column
// a resolved spec field" for both hydration and rendering.
export const RESOLVED_FIELD_COLUMN_KEYS = new Set<StyleColumnKey>([
  "styleNumber",
  "composition",
  "composition2",
  "colourName",
  "colourCode",
  "washCare",
  "sizes",
  "countryOfOrigin",
  "cartonQty",
  "klNumber",
  "lot",
  "supplierNumber",
  "supplierEmail",
  "price",
  "productNameTranslations",
  "certificates",
  "customerItemNo",
  "barcodeNumber",
  "batchNo",
  "targetGroup",
  "customerOrderNo",
  "deliveryTerm",
  "description",
  "prodNumber",
  "campaignWeek",
  "salesUnit",
  "trims",
  "productGroup",
]);

export const STYLE_TABLE_COLUMNS: ReadonlyArray<StyleColumnDef> = [
  // ── Core (the original view) ─────────────────────────────────────────────
  { key: "style", label: "Style", group: "core", locked: true },
  { key: "po", label: "PO", group: "core" },
  { key: "customer", label: "Customer", group: "core" },
  { key: "businessArea", label: "Business area", group: "core" },
  { key: "group", label: "Group", group: "core" },
  // Generation sits where Completion used to be; Completion follows it,
  // hidden in the standard view (kept togglable — the % is still stored).
  { key: "generation", label: "Generation", group: "core" },
  { key: "completion", label: "Completion", group: "core" },
  { key: "status", label: "Status", group: "core" },
  { key: "ean", label: "EAN", group: "core" },
  { key: "lastSynced", label: "Last synced", group: "core" },

  // ── Identity & links ─────────────────────────────────────────────────────
  { key: "supplier", label: "Supplier", group: "identity" },
  { key: "prodSpec", label: "Prod spec", group: "identity" },
  { key: "cartonEan", label: "Carton EAN", group: "identity" },
  { key: "poFile", label: "PO file", group: "identity" },
  { key: "styleFolder", label: "Style folder", group: "identity" },
  { key: "monday", label: "Monday", group: "identity" },
  { key: "created", label: "Created", group: "identity" },
  { key: "updated", label: "Updated", group: "identity" },

  // ── Spec fields (resolved from the customer mapping) ─────────────────────
  { key: "styleNumber", label: "Style number", group: "spec" },
  { key: "composition", label: "Composition", group: "spec" },
  { key: "composition2", label: "Composition 2", group: "spec" },
  { key: "colourName", label: "Colour name", group: "spec" },
  { key: "colourCode", label: "Colour code", group: "spec" },
  { key: "washCare", label: "Wash care", group: "spec" },
  { key: "sizes", label: "Sizes", group: "spec" },
  { key: "countryOfOrigin", label: "Country of origin", group: "spec" },
  { key: "cartonQty", label: "Carton qty (outer VE)", group: "spec" },
  { key: "klNumber", label: "KL number", group: "spec" },
  { key: "lot", label: "Lot", group: "spec" },
  { key: "supplierNumber", label: "Supplier number", group: "spec" },
  { key: "supplierEmail", label: "Supplier email", group: "spec" },
  { key: "price", label: "Price", group: "spec" },
  { key: "productNameTranslations", label: "Product name (translations)", group: "spec" },
  { key: "certificates", label: "Certificates", group: "spec" },
  { key: "customerItemNo", label: "Customer article no.", group: "spec" },
  { key: "barcodeNumber", label: "Barcode number", group: "spec" },
  { key: "batchNo", label: "Batch no.", group: "spec" },
  { key: "targetGroup", label: "Target group", group: "spec" },
  { key: "customerOrderNo", label: "Customer order no.", group: "spec" },
  { key: "deliveryTerm", label: "Delivery term", group: "spec" },
  { key: "description", label: "Description", group: "spec" },
  { key: "prodNumber", label: "Prod number", group: "spec" },
  { key: "campaignWeek", label: "Campaign week", group: "spec" },
  { key: "salesUnit", label: "Sales unit", group: "spec" },
  { key: "trims", label: "Trims", group: "spec" },
  { key: "productGroup", label: "Product group", group: "spec" },

  // ── SharePoint & delivery ────────────────────────────────────────────────
  { key: "sharepoint", label: "SharePoint upload", group: "delivery" },
  { key: "folderConnected", label: "Folder connected", group: "delivery" },
  { key: "approvedFolder", label: "Approved-layouts folder", group: "delivery" },
  { key: "deliversOwn", label: "Delivers own", group: "delivery" },

  // ── Review & approval ────────────────────────────────────────────────────
  { key: "approved", label: "Approved", group: "review" },
  { key: "fullyApproved", label: "Fully approved", group: "review" },
  { key: "awaitingReview", label: "Awaiting review", group: "review" },
];

// The standard view: the original core columns (everything except Completion).
// Every new column is opt-in — an admin turns it on in the Columns popover.
export const STANDARD_VISIBLE: ReadonlyArray<StyleColumnKey> = [
  "style",
  "po",
  "customer",
  "businessArea",
  "group",
  "generation",
  "status",
  "ean",
  "lastSynced",
];

const KNOWN_KEYS = new Set<string>(STYLE_TABLE_COLUMNS.map((c) => c.key));

// True when a visible column needs the batched supplier-upload rollup query
// (page.tsx only runs it when the SharePoint-upload column is on).
export function needsSupplierUploadData(visible: readonly StyleColumnKey[]): boolean {
  return visible.includes("sharepoint");
}

// True when any visible column needs the batched review/approval rollup query.
const REVIEW_ROLLUP_KEYS = new Set<StyleColumnKey>(["approved", "fullyApproved", "awaitingReview"]);
export function needsReviewRollupData(visible: readonly StyleColumnKey[]): boolean {
  return visible.some((k) => REVIEW_ROLLUP_KEYS.has(k));
}

// The visible resolved spec-field keys — the set page.tsx hydrates per row.
export function visibleResolvedFieldKeys(visible: readonly StyleColumnKey[]): StyleColumnKey[] {
  return visible.filter((k) => RESOLVED_FIELD_COLUMN_KEYS.has(k));
}

// Sanitize a stored / user-supplied value: drop unknown keys (forward compat
// when columns are renamed or added later), force locked columns on, and
// return canonical order. Anything that isn't an array — missing AppSetting
// row, legacy shape — falls back to the standard view.
export function normalizeVisibleColumns(raw: unknown): StyleColumnKey[] {
  if (!Array.isArray(raw)) return [...STANDARD_VISIBLE];
  const wanted = new Set<string>(raw.filter((k): k is string => typeof k === "string" && KNOWN_KEYS.has(k)));
  for (const col of STYLE_TABLE_COLUMNS) {
    if (col.locked) wanted.add(col.key);
  }
  return STYLE_TABLE_COLUMNS.filter((c) => wanted.has(c.key)).map((c) => c.key);
}

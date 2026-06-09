// Central registry for Monday board IDs and column IDs we mirror locally.
// Values come from env vars so an admin can re-point them without a deploy.
// Defaults match the IDs locked in the Phase-2 plan.

export const MONDAY_BOARDS = {
  styles: process.env.MONDAY_STYLES_BOARD_ID ?? "6979419195",
  customers: process.env.MONDAY_CUSTOMERS_BOARD_ID ?? "3317892788",
  suppliers: process.env.MONDAY_SUPPLIERS_BOARD_ID ?? "3363275451",
  // Pre Order board — added for the ghost-DB sink only. Ingest/webhook
  // semantics aren't wired against this board yet; the Monday page can
  // introspect and sink it via the generic /api/admin/monday/sink route.
  preOrder: process.env.MONDAY_PRE_ORDER_BOARD_ID ?? "7322835224",
  // Translations board — the canonical English→multilang dictionary. Sunk
  // into ghost tables and transformed into the Translation catalogue by
  // syncTranslations (src/lib/monday/translations.ts).
  translations: process.env.MONDAY_TRANSLATIONS_BOARD_ID ?? "9671510799",
} as const;

// Friendly labels for the admin Monday page (board picker, data sub-tabs).
// Keyed by the same key as MONDAY_BOARDS so the mapping stays type-safe.
export const MONDAY_BOARD_LABELS: Record<keyof typeof MONDAY_BOARDS, string> = {
  styles: "Styles",
  customers: "Customers",
  suppliers: "Suppliers",
  preOrder: "Pre Order",
  translations: "Translations",
};

// Column IDs on the Customers board (3317892788). The plan dictates which
// columns we mirror; the actual IDs need to come from Dilip / Monday admin.
// Until set, sync silently leaves the field null.
export const MONDAY_CUSTOMER_COLS = {
  account: process.env.MONDAY_CUSTOMER_COL_ACCOUNT ?? "",
  priority: process.env.MONDAY_CUSTOMER_COL_PRIORITY ?? "",
  salesResponsible: process.env.MONDAY_CUSTOMER_COL_SALES_RESPONSIBLE ?? "",
  country: process.env.MONDAY_CUSTOMER_COL_COUNTRY ?? "",
  location: process.env.MONDAY_CUSTOMER_COL_LOCATION ?? "",
} as const;

// Column IDs on the Suppliers board (3363275451).
export const MONDAY_SUPPLIER_COLS = {
  purchaser: process.env.MONDAY_SUPPLIER_COL_PURCHASER ?? "",
  address: process.env.MONDAY_SUPPLIER_COL_ADDRESS ?? "",
  location: process.env.MONDAY_SUPPLIER_COL_LOCATION ?? "",
  postCode: process.env.MONDAY_SUPPLIER_COL_POST_CODE ?? "",
  country: process.env.MONDAY_SUPPLIER_COL_COUNTRY ?? "",
  sharepointUrl: process.env.MONDAY_SUPPLIER_COL_SHAREPOINT_URL ?? "",
} as const;

// Column IDs on the Styles board (6979419195).
// `customerLink` / `supplierLink` are Monday "item connect" columns whose
// JSON value carries the linked item ids; the ingest reads those and looks
// up the local Customer/Supplier mirrors.
export const MONDAY_STYLE_COLS = {
  customerLink: process.env.MONDAY_STYLE_COL_CUSTOMER_LINK ?? "",
  supplierLink: process.env.MONDAY_STYLE_COL_SUPPLIER_LINK ?? "",
  businessArea: process.env.MONDAY_STYLE_COL_BUSINESS_AREA ?? "",
  poNumber: process.env.MONDAY_STYLE_COL_PO_NUMBER ?? "",
  styleFolderUrl: process.env.MONDAY_STYLE_COL_FOLDER_LINK ?? "",
} as const;

// Column IDs on the Pre Order board (7322835224) — the SOURCE OF TRUTH for
// Style records. Defaults are the live column ids confirmed against the
// sunk board; env vars let an admin re-point without a deploy. The link
// columns are Monday "item connect" / board-relation columns whose linked
// ids the sink backfills into `value`; absent a link, ingest falls back to
// the leading-token heuristic on the item name.
export const MONDAY_PRE_ORDER_COLS = {
  customerLink: process.env.MONDAY_PRE_ORDER_COL_CUSTOMER_LINK ?? "customer__1",
  supplierLink: process.env.MONDAY_PRE_ORDER_COL_SUPPLIER_LINK ?? "supplier__1",
  businessArea: process.env.MONDAY_PRE_ORDER_COL_BUSINESS_AREA ?? "status_18__1",
  poNumber: process.env.MONDAY_PRE_ORDER_COL_PO_NUMBER ?? "text44__1",
  styleFolderUrl: process.env.MONDAY_PRE_ORDER_COL_FOLDER_LINK ?? "link_mkrca16v",
} as const;

export function listKnownBoardIds(): string[] {
  return listKnownBoards().map((b) => b.id);
}

// Iteration helper — produces { key, id, label } triples for every known
// board in declaration order. Used by the sink-all route and the data tab's
// board sub-navigation.
export function listKnownBoards(): Array<{
  key: keyof typeof MONDAY_BOARDS;
  id: string;
  label: string;
}> {
  return (Object.keys(MONDAY_BOARDS) as Array<keyof typeof MONDAY_BOARDS>).map((key) => ({
    key,
    id: MONDAY_BOARDS[key],
    label: MONDAY_BOARD_LABELS[key],
  }));
}

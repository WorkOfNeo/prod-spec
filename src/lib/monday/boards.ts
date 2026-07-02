// Central registry for Monday board IDs and column IDs we mirror locally.
// Values come from env vars so an admin can re-point them without a deploy.
// Defaults match the IDs locked in the Phase-2 plan.

export const MONDAY_BOARDS = {
  styles: process.env.MONDAY_STYLES_BOARD_ID ?? "6979419195",
  customers: process.env.MONDAY_CUSTOMERS_BOARD_ID ?? "3317892788",
  suppliers: process.env.MONDAY_SUPPLIERS_BOARD_ID ?? "3363275451",
  // Supplier Contacts board — contact PEOPLE at each supplier company,
  // linked to the Suppliers board via a board-relation column. Mirrored so
  // email sending can resolve real contact recipients per supplier.
  supplierContacts: process.env.MONDAY_SUPPLIER_CONTACTS_BOARD_ID ?? "3363269178",
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
  supplierContacts: "Supplier Contacts",
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
  // Supplier's main inbox (To: on the "ready for review" email) and the
  // named contact person at the supplier (CC:). Until these env vars point
  // at real board columns, sync leaves the fields null and the approval
  // flow falls back to SUPPLIER_NOTIFICATION_EMAIL.
  email: process.env.MONDAY_SUPPLIER_COL_EMAIL ?? "",
  contactEmail: process.env.MONDAY_SUPPLIER_COL_CONTACT_EMAIL ?? "",
  contactName: process.env.MONDAY_SUPPLIER_COL_CONTACT_NAME ?? "",
} as const;

// Column IDs on the Supplier Contacts board (3363269178). Defaults are the
// live ids confirmed against the board on 2026-07-02. `supplierLink` is a
// board-relation column pointing at the Suppliers board (3363275451);
// sync resolves its linked item id through the local Supplier mirror.
export const MONDAY_SUPPLIER_CONTACT_COLS = {
  supplierLink: process.env.MONDAY_SUPPLIER_CONTACT_COL_SUPPLIER_LINK ?? "board_relation__1",
  email: process.env.MONDAY_SUPPLIER_CONTACT_COL_EMAIL ?? "contact_email",
  phone: process.env.MONDAY_SUPPLIER_CONTACT_COL_PHONE ?? "contact_phone",
  // "Title" is a TEXT column despite its id ("dropdown").
  title: process.env.MONDAY_SUPPLIER_CONTACT_COL_TITLE ?? "dropdown",
  // "Type" status column — "Product Supplier" / "Cost Supplier" / "–".
  contactType: process.env.MONDAY_SUPPLIER_CONTACT_COL_TYPE ?? "status",
  // "Status" status column — "Active" / "Passive".
  status: process.env.MONDAY_SUPPLIER_CONTACT_COL_STATUS ?? "status9",
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
  // Person column on the "🛍️ Styles" board (6979419195) naming who is
  // responsible toward the customer for a style. When a style is fully
  // approved the approval-chain emails this person ("Customer Contact" =
  // people_Mjj6yEkx in the live board). Empty ⇒ no customer email sent.
  // It is a PEOPLE column → resolve the linked Monday user(s) to email via
  // getUserEmails(). Re-point with MONDAY_STYLE_CUSTOMER_RESPONSIBLE_COL.
  customerResponsible: process.env.MONDAY_STYLE_CUSTOMER_RESPONSIBLE_COL ?? "",
} as const;

// Approval chain-reaction config for the "🛍️ Styles" board (6979419195).
// When every ProdSpec output for a style is approved we flip the two
// ProdSpec-owned subitems to "Approved" on that board's subitem board
// (discovered at runtime via subitem.board.id — "Subitems of 🛍️ Styles",
// 6979430232). All values are env-wired so an admin can re-point without a
// deploy. Defaults are the live ids confirmed against the board on
// 2026-06-16.
//   • statusCol  — the subitem "🪜 Status" column id.
//   • approvedLabel — the exact label to set (index 1 in the live board).
//   • approveCodes — leading code-tokens (text before the first ".") of the
//     subitems ProdSpec produces: 01e "Label/Packaging layouts" and
//     01f "Box marking layouts". Comma-separated; matched case-insensitively.
export const MONDAY_STYLE_SUBITEM = {
  statusCol: process.env.MONDAY_SUBITEM_STATUS_COL ?? "status",
  approvedLabel: process.env.MONDAY_SUBITEM_APPROVED_LABEL ?? "Approved",
  approveCodes: (process.env.MONDAY_SUBITEM_APPROVE_CODES ?? "01e,01f")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
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

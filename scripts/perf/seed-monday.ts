// Pre-Order board item builder for the perf seed (scripts/perf/seed.ts).
//
// Style.rawData is the Monday item exactly as ingestMondayItem stores it
// (src/lib/monday/ingest.ts): the API shape from getItem (ITEM_FIELDS in
// src/lib/monday/client.ts — `value` is a JSON *string*, board_relation
// columns carry `linked_item_ids` + `display_value`, mirrors carry
// `display_value`) plus the synthetic "__name__" column. Ghost items store the
// same item through serializeColumnValues (src/lib/monday/sink.ts) — `value`
// parsed, board links backfilled into `linkedPulseIds`, mirror text filled
// from display_value. Both shapes are built here from one set of facts so a
// promoted ghost item and its Style row agree, as they do in production.
//
// Column ids are the live Pre-Order ids the app maps (DEFAULT_COLUMN_MAPPING
// in src/lib/customers/config.ts, MONDAY_PRE_ORDER_COLS and the barcode text
// columns in src/lib/monday/boards.ts); the rest are board columns the app
// doesn't map but every real item still carries — they are most of the bytes.

import type { MondayColumnValue, MondayItem } from "@/lib/monday/client";

export const PRE_ORDER_BOARD_ID = "7322835224";

export type ColumnDef = { id: string; title: string; type: string };

export const PRE_ORDER_COLUMNS: ColumnDef[] = [
  { id: "subitems__1", title: "Subitems", type: "subtasks" },
  { id: "person", title: "Purchaser", type: "people" },
  { id: "status", title: "Order Status", type: "status" },
  { id: "customer__1", title: "Customer", type: "board_relation" },
  { id: "supplier__1", title: "Supplier", type: "board_relation" },
  { id: "status_18__1", title: "👔 Business Area", type: "status" },
  { id: "text44__1", title: "#️⃣ PO Number", type: "text" },
  { id: "link_mkrca16v", title: "Style Folder", type: "link" },
  { id: "text64__1", title: "Composition", type: "text" },
  { id: "text_mktbv53f", title: "2nd Composition", type: "text" },
  { id: "text_mktbynx8", title: "Color Name From Client", type: "text" },
  { id: "dropdown__1", title: "🎨 Color Code", type: "dropdown" },
  { id: "certifications__1", title: "🪪 Certificates", type: "dropdown" },
  { id: "mirror__1", title: "🌍 Country of Origin", type: "mirror" },
  { id: "sizes__1", title: "Sizes", type: "dropdown" },
  { id: "text76__1", title: "Size Ratio", type: "text" },
  { id: "text_uom__1", title: "Unit of measurement", type: "text" },
  { id: "dropdown_mktbzd1f", title: "Wash Care Symbols", type: "dropdown" },
  { id: "numeric_mktagw13", title: "Lot No", type: "numbers" },
  { id: "text2__1", title: "Qty/Carton", type: "text" },
  { id: "numeric_mktagpmg", title: "Carton Barcode number", type: "numbers" },
  { id: "text_mkv0ebfg", title: "KL No.", type: "text" },
  { id: "retail_prices__1", title: "Retail Prices", type: "text" },
  { id: "text91__1", title: "🔑 Customer Item No", type: "text" },
  { id: "text99__1", title: "Consignment", type: "text" },
  { id: "numeric_mkta3mqk", title: "Barcode Number (numeric)", type: "numbers" },
  { id: "numeric_mkta7tzg", title: "Batch nr", type: "numbers" },
  { id: "status87__1", title: "🎯 Target Group", type: "status" },
  { id: "customer_order_number__1", title: "🔢 Customer Order Number", type: "text" },
  { id: "dup__of_status__1", title: "🌍 Shipping Terms", type: "status" },
  { id: "long_text_mkrvd8j3", title: "Description", type: "long_text" },
  { id: "numeric_mkta1jd5", title: "Prod number", type: "numbers" },
  { id: "text33__1", title: "📅 Campaign Week", type: "text" },
  { id: "numeric_mkta4201", title: "Sales unit", type: "numbers" },
  { id: "dropdown4__1", title: "👜 Trims", type: "dropdown" },
  { id: "dropdown9__1", title: "🗂️ Product Group", type: "dropdown" },
  { id: "___style_comments__1", title: "💬 Style Comments", type: "long_text" },
  { id: "text_mm51c0mj", title: "Barcode Number", type: "text" },
  { id: "text_mm51twj9", title: "Carton Barcode number 1", type: "text" },
  { id: "people_Mjj6yEkx", title: "Customer Contact", type: "people" },
  { id: "date4", title: "ETD", type: "date" },
  { id: "date_mkt3x0aa", title: "ETA", type: "date" },
  { id: "numbers3__1", title: "Order Qty", type: "numbers" },
  { id: "status_1__1", title: "Sample Status", type: "status" },
  { id: "status_mkv2k1pa", title: "Artwork Status", type: "status" },
  { id: "files__1", title: "PO File", type: "file" },
  { id: "files_mkx9w2rt", title: "Artwork", type: "file" },
  { id: "checkbox__1", title: "Rush", type: "checkbox" },
  { id: "timeline__1", title: "Production Window", type: "timeline" },
  { id: "formula__1", title: "Days to ETD", type: "formula" },
  { id: "item_id__1", title: "Item ID", type: "item_id" },
  { id: "creation_log__1", title: "Created", type: "creation_log" },
  { id: "last_updated__1", title: "Last Updated", type: "last_updated" },
  { id: "text_season__1", title: "Season", type: "text" },
  { id: "dropdown_brand__1", title: "Brand / License", type: "dropdown" },
  { id: "text_factory_style__1", title: "Factory Style No", type: "text" },
  { id: "numbers_fob__1", title: "FOB Price", type: "numbers" },
  { id: "text_currency__1", title: "Currency", type: "text" },
  { id: "country__1", title: "Ship-to Country", type: "country" },
  { id: "text_hs__1", title: "HS Code", type: "text" },
  { id: "numbers_weight__1", title: "Carton Weight (kg)", type: "numbers" },
  { id: "email__1", title: "Supplier QC Email", type: "email" },
  { id: "mirror_mkt1supp", title: "Supplier Country", type: "mirror" },
  { id: "lookup_mkt1name", title: "Supplier Name", type: "mirror" },
  { id: "long_text_internal__1", title: "Internal Notes", type: "long_text" },
  { id: "text_label_supplier__1", title: "Label Supplier", type: "text" },
  { id: "date_pps__1", title: "PP Sample Date", type: "date" },
  { id: "status_qc__1", title: "QC Status", type: "status" },
];

// Status / dropdown label sets — reused for the ghost dropdown-option rows so
// the option catalogue and the item values agree.
export const ORDER_STATUSES = ["Order placed", "In production", "Shipped", "On hold", "Cancelled"];
export const SAMPLE_STATUSES = ["Approved", "Waiting", "Rejected", "Not needed"];
export const ARTWORK_STATUSES = ["Done", "Working on it", "Waiting for customer", "Stuck"];
export const TARGET_GROUPS = ["Women", "Men", "Kids", "Baby", "Unisex", "Home"];
export const SHIPPING_TERMS = ["FOB", "DDP", "DDU", "DAP", "–"];
export const COLOUR_CODES = ["*A", "*B", "*C", "100", "200", "305", "410", "550", "690", "800", "999"];
export const CERTIFICATES = ["OEKO-TEX", "GOTS", "FSC", "BCI", "GRS", "RCS"];
export const PRODUCT_GROUPS = [
  "T-Shirt", "Socks", "Shoes", "Pyjamas", "Underwear", "Towel", "Bedlinen", "Hoodie",
  "Leggings", "Cap", "Gloves", "Blanket", "Bag", "Swimwear", "Jacket",
];
export const TRIMS = [
  "Care Label", "Wash Care Label with Oeko-tex Logo", "Hangtag", "Price Sticker",
  "Polybag Sticker", "Master Polybag", "Carton Marking", "Banderole", "Info Area",
  "Printed Hanger", "Main Label", "Size Sticker",
];
export const BRANDS = [
  "Private Label", "Paw Patrol", "Disney Frozen", "Pokémon", "Minecraft", "Peppa Pig",
  "Marvel", "Harry Potter", "Body Guide", "Gabby's Dollhouse",
];
export const QC_STATUSES = ["Passed", "Pending", "Failed", "Re-inspection"];
export const WASH_CARE_LABELS = [
  "Wash at or below 30℃", "Wash at or below 40℃", "Wash at or below 60℃",
  "Hand wash", "Do not bleach", "Do not tumble dry", "Tumble dry low",
  "Iron low", "Iron medium", "Do not iron", "Do not dry clean",
  "Dry Clean, Any Solvent", "Professional wet cleaning",
];

export type ItemFacts = {
  mondayItemId: string;
  name: string;
  groupId: string;
  groupTitle: string;
  createdAt: Date;
  updatedAt: Date;
  customer: { mondayItemId: string; name: string } | null;
  supplier: { mondayItemId: string; name: string; country: string } | null;
  businessArea: string; // Monday label; "" = unset
  poNumber: string; // "" = unset
  folderUrl: string;
  composition: string;
  composition2: string;
  colourName: string;
  colourCode: string;
  certificates: string[];
  countryOfOrigin: string;
  sizes: string[];
  sizeRatio: string;
  unitOfMeasure: string;
  washCare: string[];
  lot: number | null;
  cartonQty: string;
  cartonEan: string;
  klNumber: string;
  price: string;
  customerItemNo: string;
  consignmentCode: string;
  barcodeNumber: string;
  batchNo: number | null;
  targetGroup: string;
  customerOrderNo: string;
  deliveryTerm: string;
  description: string;
  prodNumber: number | null;
  campaignWeek: string;
  salesUnit: number | null;
  trims: string[];
  productGroup: string;
  styleComments: string;
  internalNotes: string;
  labelSupplier: string;
  qcStatus: string;
  barcodeText: string; // "S:5701…, M:5701…" buyer-typed per-size list
  cartonBarcodeText: string;
  orderQty: number;
  orderStatus: string;
  sampleStatus: string;
  artworkStatus: string;
  season: string;
  brand: string;
  factoryStyle: string;
  fobPrice: number;
  hsCode: string;
  weightKg: number;
  qcEmail: string;
  purchaser: { id: number; name: string };
  customerContact: { id: number; name: string };
  subitemIds: number[];
  rush: boolean;
  // Mapped column ids whose Monday cell is empty for this item — what keeps
  // a share of the book "awaiting data" on the readiness walks.
  blank: ReadonlySet<string>;
};

const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

type Cv = MondayColumnValue;

// Build one live-API item (value = JSON string). Every cell carries a
// `changed_at` stamp in its value like the real API does — it is a large part
// of why real items run 10–20 KB.
export function buildPreOrderItem(f: ItemFacts): MondayItem {
  const changed = (offsetDays: number) => iso(addDays(f.createdAt, offsetDays));
  const blank = (id: string) => f.blank.has(id);

  const text = (id: string, s: string): Cv =>
    blank(id) || !s ? { id, type: "text", text: "", value: null } : { id, type: "text", text: s, value: JSON.stringify(s) };
  const num = (id: string, n: number | null): Cv =>
    blank(id) || n == null
      ? { id, type: "numbers", text: "", value: null }
      : { id, type: "numbers", text: String(n), value: JSON.stringify(String(n)) };
  const status = (id: string, label: string, labels: string[], at: number): Cv =>
    blank(id) || !label
      ? { id, type: "status", text: null, value: null }
      : {
          id,
          type: "status",
          text: label,
          value: JSON.stringify({ index: Math.max(0, labels.indexOf(label)), post_id: null, changed_at: changed(at) }),
        };
  const dropdown = (id: string, labels: string[], catalogue: string[], at: number): Cv =>
    blank(id) || labels.length === 0
      ? { id, type: "dropdown", text: "", value: null }
      : {
          id,
          type: "dropdown",
          text: labels.join(", "),
          value: JSON.stringify({
            ids: labels.map((l) => (catalogue.indexOf(l) >= 0 ? catalogue.indexOf(l) + 1 : l.length + 100)),
            changed_at: changed(at),
          }),
        };
  const longText = (id: string, s: string, at: number): Cv =>
    blank(id) || !s
      ? { id, type: "long_text", text: "", value: null }
      : { id, type: "long_text", text: s, value: JSON.stringify({ text: s, changed_at: changed(at) }) };
  const people = (id: string, p: { id: number; name: string }, at: number): Cv => ({
    id,
    type: "people",
    text: p.name,
    value: JSON.stringify({ personsAndTeams: [{ id: p.id, kind: "person" }], changed_at: changed(at) }),
  });
  const date = (id: string, d: Date, at: number): Cv => ({
    id,
    type: "date",
    text: ymd(d),
    value: JSON.stringify({ date: ymd(d), icon: null, changed_at: changed(at) }),
  });
  const file = (id: string, names: string[], assetBase: number): Cv =>
    names.length === 0
      ? { id, type: "file", text: "", value: null }
      : {
          id,
          type: "file",
          text: names.map((n, i) => `https://contrast.monday.com/protected_static/1234567/resources/${assetBase + i}/${encodeURIComponent(n)}`).join(", "),
          value: JSON.stringify({
            files: names.map((n, i) => ({
              name: n,
              assetId: assetBase + i,
              isImage: "false",
              fileType: "ASSET",
              createdAt: f.createdAt.getTime() + i * 60_000,
              createdBy: String(f.purchaser.id),
            })),
          }),
        };
  // board_relation on API 2024-10+: legacy `value` is null, the link lives in
  // linked_item_ids (the BoardRelationValue fragment ITEM_FIELDS asks for).
  const relation = (id: string, linked: { mondayItemId: string; name: string } | null): Cv =>
    linked
      ? { id, type: "board_relation", text: null, value: null, linked_item_ids: [linked.mondayItemId], display_value: linked.name }
      : { id, type: "board_relation", text: null, value: null, linked_item_ids: [], display_value: "" };
  // Mirrors return an empty text; the value lives in display_value.
  const mirror = (id: string, display: string): Cv => ({
    id,
    type: "mirror",
    text: "",
    value: null,
    display_value: blank(id) ? "" : display,
  });

  const eta = addDays(f.createdAt, 75);
  const etd = addDays(f.createdAt, 45);

  const columnValues: Cv[] = [
    {
      id: "subitems__1",
      type: "subtasks",
      text: f.subitemIds.map((n) => `Subitem ${n}`).join(", "),
      value: JSON.stringify({ linkedPulseIds: f.subitemIds.map((n) => ({ linkedPulseId: n })) }),
    },
    people("person", f.purchaser, 0),
    status("status", f.orderStatus, ORDER_STATUSES, 3),
    relation("customer__1", f.customer),
    relation("supplier__1", f.supplier),
    status("status_18__1", f.businessArea, [], 0),
    text("text44__1", f.poNumber),
    blank("link_mkrca16v") || !f.folderUrl
      ? { id: "link_mkrca16v", type: "link", text: "", value: null }
      : {
          id: "link_mkrca16v",
          type: "link",
          text: `Style folder - ${f.folderUrl}`,
          value: JSON.stringify({ url: f.folderUrl, text: "Style folder", changed_at: changed(1) }),
        },
    text("text64__1", f.composition),
    text("text_mktbv53f", f.composition2),
    text("text_mktbynx8", f.colourName),
    dropdown("dropdown__1", f.colourCode ? [f.colourCode] : [], COLOUR_CODES, 2),
    dropdown("certifications__1", f.certificates, CERTIFICATES, 2),
    mirror("mirror__1", f.countryOfOrigin),
    dropdown("sizes__1", f.sizes, [], 2),
    text("text76__1", f.sizeRatio),
    text("text_uom__1", f.unitOfMeasure),
    dropdown("dropdown_mktbzd1f", f.washCare, WASH_CARE_LABELS, 4),
    num("numeric_mktagw13", f.lot),
    text("text2__1", f.cartonQty),
    num("numeric_mktagpmg", f.cartonEan ? Number(f.cartonEan) : null),
    text("text_mkv0ebfg", f.klNumber),
    text("retail_prices__1", f.price),
    text("text91__1", f.customerItemNo),
    text("text99__1", f.consignmentCode),
    num("numeric_mkta3mqk", f.barcodeNumber ? Number(f.barcodeNumber) : null),
    num("numeric_mkta7tzg", f.batchNo),
    status("status87__1", f.targetGroup, TARGET_GROUPS, 1),
    text("customer_order_number__1", f.customerOrderNo),
    status("dup__of_status__1", f.deliveryTerm, SHIPPING_TERMS, 1),
    longText("long_text_mkrvd8j3", f.description, 2),
    num("numeric_mkta1jd5", f.prodNumber),
    text("text33__1", f.campaignWeek),
    num("numeric_mkta4201", f.salesUnit),
    dropdown("dropdown4__1", f.trims, TRIMS, 5),
    dropdown("dropdown9__1", f.productGroup ? [f.productGroup] : [], PRODUCT_GROUPS, 1),
    longText("___style_comments__1", f.styleComments, 6),
    text("text_mm51c0mj", f.barcodeText),
    text("text_mm51twj9", f.cartonBarcodeText),
    people("people_Mjj6yEkx", f.customerContact, 0),
    date("date4", etd, 1),
    date("date_mkt3x0aa", eta, 1),
    num("numbers3__1", f.orderQty),
    status("status_1__1", f.sampleStatus, SAMPLE_STATUSES, 9),
    status("status_mkv2k1pa", f.artworkStatus, ARTWORK_STATUSES, 12),
    file("files__1", f.poNumber ? [`${f.poNumber}.pdf`] : [], 900_000_000 + Number(f.mondayItemId.slice(-6))),
    file("files_mkx9w2rt", [`${f.name} artwork v2.ai`, `${f.name} techpack.pdf`], 910_000_000 + Number(f.mondayItemId.slice(-6)) * 2),
    f.rush
      ? { id: "checkbox__1", type: "checkbox", text: "v", value: JSON.stringify({ checked: "true", changed_at: changed(0) }) }
      : { id: "checkbox__1", type: "checkbox", text: "", value: null },
    {
      id: "timeline__1",
      type: "timeline",
      text: `${ymd(addDays(f.createdAt, 7))} - ${ymd(etd)}`,
      value: JSON.stringify({ from: ymd(addDays(f.createdAt, 7)), to: ymd(etd), changed_at: changed(1) }),
    },
    { id: "formula__1", type: "formula", text: "", value: null },
    { id: "item_id__1", type: "item_id", text: f.mondayItemId, value: null },
    {
      id: "creation_log__1",
      type: "creation_log",
      text: `${ymd(f.createdAt)} ${iso(f.createdAt).slice(11, 19)} UTC`,
      value: null,
    },
    {
      id: "last_updated__1",
      type: "last_updated",
      text: `${ymd(f.updatedAt)} ${iso(f.updatedAt).slice(11, 19)} UTC`,
      value: JSON.stringify({ updated_at: iso(f.updatedAt), updater_id: String(f.purchaser.id) }),
    },
    text("text_season__1", f.season),
    dropdown("dropdown_brand__1", [f.brand], BRANDS, 0),
    text("text_factory_style__1", f.factoryStyle),
    num("numbers_fob__1", f.fobPrice),
    text("text_currency__1", "USD"),
    {
      id: "country__1",
      type: "country",
      text: "Denmark",
      value: JSON.stringify({ countryCode: "DK", countryName: "Denmark", changed_at: changed(0) }),
    },
    text("text_hs__1", f.hsCode),
    num("numbers_weight__1", f.weightKg),
    {
      id: "email__1",
      type: "email",
      text: f.qcEmail,
      value: JSON.stringify({ email: f.qcEmail, text: f.qcEmail, changed_at: changed(0) }),
    },
    mirror("mirror_mkt1supp", f.supplier?.country ?? ""),
    mirror("lookup_mkt1name", f.supplier?.name ?? ""),
    longText("long_text_internal__1", f.internalNotes, 8),
    text("text_label_supplier__1", f.labelSupplier),
    date("date_pps__1", addDays(f.createdAt, 20), 3),
    status("status_qc__1", f.qcStatus, QC_STATUSES, 30),
  ];

  return {
    id: f.mondayItemId,
    name: f.name,
    board: { id: PRE_ORDER_BOARD_ID },
    group: { id: f.groupId, title: f.groupTitle },
    column_values: columnValues,
  };
}

// Style.rawData: the item plus the synthetic "__name__" column, exactly as
// ingestMondayItem merges it.
export function styleRawData(item: MondayItem): object {
  return {
    ...item,
    column_values: [...item.column_values, { id: "__name__", type: "name", text: item.name, value: null }],
  };
}

// MondayGhostItem.columnValues: mirrors serializeColumnValues in sink.ts.
export function ghostColumnValues(item: MondayItem): object[] {
  return item.column_values.map((cv) => {
    let value: unknown = null;
    if (cv.value) {
      try {
        value = JSON.parse(cv.value);
      } catch {
        value = cv.value;
      }
    }
    if ((value === null || value === undefined) && Array.isArray(cv.linked_item_ids) && cv.linked_item_ids.length > 0) {
      value = { linkedPulseIds: cv.linked_item_ids.map((id) => ({ linkedPulseId: String(id) })) };
    }
    return {
      id: cv.id,
      type: cv.type ?? null,
      text: cv.text && cv.text.trim() ? cv.text : (cv.display_value ?? null),
      value,
    };
  });
}

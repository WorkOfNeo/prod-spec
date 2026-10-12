import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleListContext, StyleListProdSpec, StyleListSource } from "./list-rows";
import type { StyleListRow } from "./table-row";

// list-rows.ts imports @/lib/db, whose client construction needs DATABASE_URL
// at import time. Nothing here queries — the pg pool is lazy.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let buildStyleListRow: typeof import("./list-rows").buildStyleListRow;
let customerConfigCache: typeof import("./list-rows").customerConfigCache;
let listPathColumnIds: typeof import("./rawdata-projection").listPathColumnIds;
let projectRawData: typeof import("./rawdata-projection").projectRawData;
let styleSearchBlob: typeof import("./table-row").styleSearchBlob;
let statusTitle: typeof import("./table-row").statusTitle;
let RESOLVED_FIELD_COLUMN_KEYS: typeof import("./table-columns").RESOLVED_FIELD_COLUMN_KEYS;
let eanStatusMeta: typeof import("@/lib/po/ean-status-meta").eanStatusMeta;
let parseCustomerConfig: typeof import("@/lib/customers/config").parseCustomerConfig;

const LAYOUT_KEY = "layout:fixture-conditional";

before(async () => {
  ({ buildStyleListRow, customerConfigCache } = await import("./list-rows"));
  ({ listPathColumnIds, projectRawData } = await import("./rawdata-projection"));
  ({ styleSearchBlob, statusTitle } = await import("./table-row"));
  ({ RESOLVED_FIELD_COLUMN_KEYS } = await import("./table-columns"));
  ({ eanStatusMeta } = await import("@/lib/po/ean-status-meta"));
  ({ parseCustomerConfig } = await import("@/lib/customers/config"));
  // An Output Builder layout exercising every way readiness reads the row: a
  // conditional (branch-aware readiness), {{orderNo}} (the FOB/DDP rule), an
  // exclude rule on productGroup and a rule on a field that is NOT a
  // ColumnMapping key (resolves the id-less entry).
  const { layoutRowToVariant } = await import("@/lib/output-layouts/variants");
  const { setDynamicVariants } = await import("@/lib/pdf/template-registry");
  const variant = layoutRowToVariant({
    id: "fixture-conditional",
    name: "Fixture sticker",
    docType: "STICKER",
    version: 1,
    isInfoArea: false,
    customLogo: null,
    definition: {
      pages: [
        {
          id: "p1",
          title: "Front",
          widthMm: 60,
          heightMm: 40,
          blocks: [
            {
              id: "b1",
              rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 },
              lines: [
                "{{styleNumber}}",
                "{{if productGroup contains Socks}}{{composition}}{{else}}{{washSymbols}} {{price}}{{endif}}",
                "Order {{orderNo}}",
              ],
            },
          ],
        },
      ],
      settings: {
        repeatBy: "none",
        splitBy: "ean",
        splitByComposition: false,
        fileName: "",
        cartonNumbering: false,
        multipleStyles: false,
        customLogoWidthPct: 100,
        rules: [
          { field: "productGroup", op: "contains", keywords: ["Shoes"], mode: "exclude" },
          { field: "legacyField", op: "notEmpty", keywords: [], mode: "exclude" },
        ],
      },
    },
  });
  assert.ok(variant, "fixture layout parses");
  setDynamicVariants([variant]);
});

const cv = (id: string, text: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  text,
  value: text == null ? null : JSON.stringify(text),
  ...extra,
});

const noise = Array.from({ length: 40 }, (_, i) =>
  cv(`noise_${i}`, "lorem ipsum ".repeat(10), { value: JSON.stringify({ text: "lorem", i }) }),
);

const CUSTOMERS = {
  netto: { id: "c-netto", name: "Netto", config: {} },
  coop: {
    id: "c-coop",
    name: "Coop",
    config: { columnMapping: { composition: "coop_composition", productGroup: "coop_pg", price: "coop_price" } },
  },
  wool: {
    id: "c-wool",
    name: "Woolworth",
    config: { skipSupplierDelivery: true, columnMapping: { composition: "manual.composition", washCare: "" } },
  },
};

const out = (variantKey: string, extra: Record<string, unknown> = {}) => ({
  variantKey,
  widthMm: 50,
  heightMm: 30,
  enabled: true,
  ...extra,
});
const PROD_SPECS: Array<StyleListProdSpec | null> = [
  null,
  {
    id: "ps-1",
    name: "Netto · Private Label",
    autoGenerateThresholdPct: 80,
    active: true,
    outputs: [
      out("netto-dk-privatelabel-wash-care-label"),
      // Has a `readiness` hook (FOB → customerOrderNo, else poNumber) + a pin.
      out("netto-dk-privatelabel-carton-marking", { fieldOverrides: { description: "Pinned" } }),
      out("netto-dk-privatelabel-info-area", { enabled: false }),
      out(LAYOUT_KEY),
    ],
  },
  {
    id: "ps-2",
    name: "Coop · License",
    autoGenerateThresholdPct: 100,
    active: false,
    outputs: [out("coop-dk-loved-62522-care-label-layout"), out("coop-dk-license-62897-price-tag-layout")],
  },
  { id: "ps-3", name: "No outputs", autoGenerateThresholdPct: 100, active: true, outputs: [] },
];

function rawData(variant: number) {
  const cols = [
    ...noise,
    cv("__name__", "IL90001", { type: "name", value: null }),
    cv("text64__1", ""),
    cv("text64__1", variant % 2 ? "95% Cotton" : ""),
    cv("coop_composition", variant % 3 ? "100% Organic Cotton" : ""),
    cv("sizes__1", "S,M,L"),
    cv("dropdown_mktbzd1f", variant % 4 === 1 ? "" : "30,Iron"),
    cv("text2__1", "12"),
    cv("long_text_mkrvd8j3", "A description"),
    cv("dup__of_status__1", variant % 2 ? "FOB" : "DDP"),
    cv("customer_order_number__1", variant % 4 ? "CO-1" : ""),
    cv("dropdown9__1", ["Socks", "Shoes", "T-Shirt"][variant % 3]),
    cv("coop_pg", ["Shoes", "Socks"][variant % 2]),
    cv("retail_prices__1", "49"),
    cv("coop_price", variant % 2 ? "" : "12"),
    { id: "mirror__1", type: "mirror", text: null, value: null, display_value: variant % 2 ? "Bangladesh" : "" },
    cv("manual.composition", variant % 2 ? "" : "80% Wool"),
  ];
  if (variant % 3 === 2) cols.push({ text: "legacy value" } as unknown as ReturnType<typeof cv>);
  return { id: "9001", name: "IL90001", board: { id: "7322835224" }, group: { id: "g", title: "Incoming" }, column_values: cols };
}

function style(i: number, customerId: string, prodSpecId: string | null): StyleListSource {
  return {
    id: `s${i}`,
    name: `IL9${i}`,
    customerId,
    prodSpecId,
    supplierId: i % 3 ? "sup-1" : null,
    businessArea: i % 4 ? "Private Label" : "–",
    poNumber: i % 5 ? `C-PO6${i}` : null,
    poSeq: i % 5 ? 6000 + i : null,
    cartonEan: i % 2 ? "5709876543210" : null,
    completionPct: (i * 13) % 101,
    eanStatus: (["NONE", "PENDING", "RESOLVED", "PO_NOT_FOUND"] as const)[i % 4],
    eanAttempts: i % 4,
    poFileName: i % 3 ? null : "C-PO1.pdf",
    groupTitle: ["Incoming", "✅ Done", "Cancelled", null][i % 4],
    pulledForTestAt: i % 7 === 0 ? new Date("2026-09-01T00:00:00Z") : null,
    styleFolderUrl: null,
    supplierFolderUrl: i % 2 ? "https://example.test/approved" : null,
    mondayItemId: String(9000 + i),
    mondayBoardId: "7322835224",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    updatedAt: new Date("2026-09-01T10:00:00Z"),
    lastSyncedAt: i % 2 ? new Date("2026-09-02T10:00:00Z") : null,
    businessAreaRef: i % 4 ? { name: "Private Label" } : null,
    supplier: i % 3 ? { name: "Dhaka Knit", country: i % 2 ? "Bangladesh" : null, sharepointUrl: " " } : null,
    eans:
      i % 2
        ? [
            { size: "S", ean13: "5700000000011", cartonEan: i % 4 === 1 ? "5800000000011" : null },
            { size: "M", ean13: null, cartonEan: null },
          ]
        : [],
    jobs: i % 3 ? [{ status: (["QUEUED", "AWAITING_REVIEW", "FAILED"] as const)[i % 3] }] : [],
    rawData: rawData(i),
  };
}

function context(overrides: Partial<StyleListContext> = {}): StyleListContext {
  return {
    autoGenerateEnabled: true,
    stylesWithPdfs: new Set(["s1", "s4", "s9"]),
    doneCutoffIds: new Set(["s5"]),
    resolvedFieldKeys: [...RESOLVED_FIELD_COLUMN_KEYS],
    wantUpload: true,
    wantReview: true,
    ignoredByStyle: new Map([["s2", new Set(["netto-dk-privatelabel-wash-care-label"])]]),
    lookalikeChips: new Map([["s3", { position: 1, total: 2, otherPoNumbers: ["C-PO2"] }]]),
    reviewerByStyle: new Map([["s1", "Ada"]]),
    supplierUploads: new Map([
      ["s1", { uploaded: 1, total: 2, noFolder: 0, ambiguous: 0, failed: 0, skipped: 0, pending: 1 }],
    ]),
    assetsByStyle: new Map([
      [
        "s4",
        [
          {
            jobId: "j1",
            variantKey: "netto-dk-privatelabel-wash-care-label",
            docType: "WASHCARE",
            reviewStatus: "APPROVED" as const,
            placeholderCount: 0,
          },
        ],
      ],
    ]),
    configFor: customerConfigCache(),
    ...overrides,
  };
}

function* fixtures() {
  let i = 0;
  for (const customer of Object.values(CUSTOMERS)) {
    for (const prodSpec of PROD_SPECS) {
      for (let k = 0; k < 4; k++, i++) yield { s: style(i, customer.id, prodSpec?.id ?? null), customer, prodSpec };
    }
  }
}

test("rows from projected rawData equal rows from the full item", () => {
  const ctx = context();
  let n = 0;
  for (const { s, customer, prodSpec } of fixtures()) {
    const ids = new Set(listPathColumnIds([parseCustomerConfig(customer.config).columnMapping]));
    const full = buildStyleListRow(s, customer, prodSpec, ctx);
    const projected = buildStyleListRow({ ...s, rawData: projectRawData(s.rawData, ids) }, customer, prodSpec, ctx);
    assert.deepEqual(projected, full, `style ${s.id} · ${customer.name} · ${prodSpec?.name ?? "no spec"}`);
    n++;
  }
  assert.equal(n, 48);
});

test("the fixtures exercise readiness, exclusion and fallbacks (not just empty rows)", () => {
  const ctx = context();
  const rows = [...fixtures()].map(({ s, customer, prodSpec }) => buildStyleListRow(s, customer, prodSpec, ctx));
  assert.ok(rows.some((r) => r.requiredTotal > 0 && r.requiredFilled < r.requiredTotal), "some fields missing");
  assert.ok(rows.some((r) => r.requiredTotal > 0 && r.requiredFilled === r.requiredTotal), "some complete");
  assert.ok(new Set(rows.map((r) => r.statusView.key)).size > 2, "several statuses");
  assert.ok(rows.some((r) => r.resolved.countryOfOrigin === "Bangladesh"), "mirror display_value");
  assert.ok(rows.some((r) => r.resolved.composition === "80% Wool"), "manual.* mapping");
  assert.ok(rows.some((r) => r.review && r.review.total > 0), "review rollup");
  assert.ok(rows.some((r) => r.archived) && rows.some((r) => !r.archived));
  assert.ok(rows.some((r) => r.customerDeliversOwn));
});

test("the row ships only what the table reads", () => {
  const [{ s, customer, prodSpec }] = [...fixtures()].slice(4, 5);
  const row = buildStyleListRow(s, customer, prodSpec, context());
  assert.deepEqual(Object.keys(row.statusView).sort(), ["key", "label"]);
  assert.deepEqual(Object.keys(row.notice).sort(), ["headline", "tone"]);
  assert.equal("searchBlob" in row, false);
  assert.equal(typeof row.statusTitle, "string");
});

test("styleSearchBlob matches the blob the server used to ship", () => {
  const ctx = context();
  for (const { s, customer, prodSpec } of fixtures()) {
    const row: StyleListRow = buildStyleListRow(s, customer, prodSpec, ctx);
    // The pre-move expression from page.tsx, over the same source values.
    const ba = s.businessAreaRef?.name ?? s.businessArea ?? null;
    const legacy = [
      s.name,
      customer.name,
      ba ?? "",
      s.poNumber ?? "",
      row.statusView.label,
      s.groupTitle ?? "",
      eanStatusMeta(s.eanStatus).label,
      s.supplier?.name ?? "",
      prodSpec?.name ?? "",
      ...Object.values(row.resolved),
    ]
      .join(" ")
      .toLowerCase();
    assert.equal(styleSearchBlob(row), legacy, s.id);
  }
});

test("statusTitle: count + top blocking step, else the headline", () => {
  const notice = {
    headline: "Missing data",
    tone: "amber" as const,
    ready: 1,
    total: 3,
    steps: [
      { key: "po", status: "ok" as const, tone: "green" as const, title: "PO", detail: "found" },
      { key: "fields", status: "waiting" as const, tone: "amber" as const, title: "Fields", detail: "Wash care" },
    ],
  };
  assert.equal(statusTitle(notice), "1 of 3 ready\nFields — Wash care");
  assert.equal(statusTitle({ ...notice, total: 0, steps: [] }), "Missing data");
});

test("formatListDate prints exactly what formatDate does", async () => {
  const { formatListDate } = await import("./list-rows");
  const { formatDate } = await import("@/lib/utils");
  assert.equal(formatListDate(null), formatDate(null));
  // A spread of instants: year/month boundaries, both DST switches, midnight
  // and noon, single- and double-digit days.
  const start = Date.UTC(2025, 11, 31, 23, 30);
  for (let i = 0; i < 400; i++) {
    const d = new Date(start + i * 22 * 3600 * 1000 + i * 7 * 60 * 1000);
    assert.equal(formatListDate(d), formatDate(d), d.toISOString());
  }
});

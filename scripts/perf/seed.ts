// Perf seed — fills DATABASE_URL with production-shaped, deterministic data so
// page timings measured locally mean something. See docs/perf/README.md.
//
//   DATABASE_URL=postgresql://postgres@localhost:5432/prodspec_p0 \
//     npx tsx scripts/perf/seed.ts [--styles 5000] [--seed 20261012] [--now <iso>]
//
// DESTRUCTIVE: truncates every table it fills (keeps the perf-admin user and
// the migration-seeded reference tables doc_types / trim_concept_rows). Refuses
// a non-local DATABASE_URL unless --force is passed.
//
// Shapes follow the code that writes these rows in production, not guesses:
// Style.rawData is the Pre-Order item as ingestMondayItem stores it
// (seed-monday.ts), customer config / ProdSpec outputs / Output Builder layouts
// are run through the app's own zod parsers before insert, variant keys come
// from the live template registry, and job/asset/review rows follow the runner
// and review-flow conventions (cover assets, "<key>#<suffix>" multi-doc keys,
// per-output reruns spreading a style's documents across several jobs).
//
// Every entity draws from its own PRNG stream keyed by (seed, entity, index),
// so the same flags give byte-identical rows; timestamps are offsets from
// --now (default: the moment the seed runs) so "2h ago" stays 2h ago.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { TEMPLATE_VARIANTS } from "@/lib/pdf/template-registry";
import { parseCustomerConfig, DEFAULT_COLUMN_MAPPING } from "@/lib/customers/config";
import { ProdSpecOutputsSchema, type ProdSpecOutput } from "@/lib/prod-spec/config";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { parsePoNumberValue } from "@/lib/po/po-number";
import {
  ARTWORK_STATUSES,
  BRANDS,
  CERTIFICATES,
  COLOUR_CODES,
  ORDER_STATUSES,
  PRE_ORDER_BOARD_ID,
  PRE_ORDER_COLUMNS,
  PRODUCT_GROUPS,
  QC_STATUSES,
  SAMPLE_STATUSES,
  SHIPPING_TERMS,
  TARGET_GROUPS,
  TRIMS,
  WASH_CARE_LABELS,
  buildPreOrderItem,
  ghostColumnValues,
  styleRawData,
  type ItemFacts,
} from "./seed-monday";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const STYLE_COUNT = Number(argValue("--styles") ?? 5000);
const SEED = Number(argValue("--seed") ?? 20261012);
const NOW = argValue("--now") ? new Date(argValue("--now")!) : new Date();
const FORCE = process.argv.includes("--force");
// Everything sized "per 5,000 styles" in the brief scales with --styles.
const SCALE = STYLE_COUNT / 5000;

if (!Number.isInteger(STYLE_COUNT) || STYLE_COUNT < 50) throw new Error("--styles must be an integer ≥ 50");
if (Number.isNaN(NOW.getTime())) throw new Error("--now must be an ISO timestamp");

const ADMIN_ID = "perf-admin";
const REVIEWERS = [
  { id: "perf-reviewer", email: "reviewer@perf.local", name: "Rita Reviewer" },
  { id: "perf-reviewer-2", email: "reviewer2@perf.local", name: "Rasmus Reviewer" },
  { id: "perf-reviewer-3", email: "reviewer3@perf.local", name: "Rikke Reviewer" },
];
const DECIDERS = [ADMIN_ID, ...REVIEWERS.map((r) => r.id)];

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  // mulberry32
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let x = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x < 0) return i;
    }
    return weights.length - 1;
  }
  sample<T>(arr: readonly T[], k: number): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(k, copy.length));
  }
  hex(len: number): string {
    let s = "";
    while (s.length < len) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
  digits(len: number): string {
    let s = "";
    while (s.length < len) s += String(Math.floor(this.next() * 10));
    return s;
  }
}

const rngFor = (label: string) => new Rng(hashString(`${SEED}:${label}`));

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const minDate = (a: Date, b: Date) => (a.getTime() < b.getTime() ? a : b);
// Follow-up events (decisions, fixes, pushes) are scheduled after the thing
// they follow; recent ones would land in the future without this cap.
const past = (d: Date) => minDate(d, minutesAgo(1));
// Reference rows (catalogues, customers, suppliers, ghost metadata) get fixed
// stamps instead of the column default now(), so --now reproduces every column.
const REF_AT = minutesAgo(60 * 24 * 500);

function ean13(base12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base12[i]) * (i % 2 === 0 ? 1 : 3);
  return base12 + String((10 - (sum % 10)) % 10);
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const LANGUAGES: Array<[string, string, string]> = [
  ["en", "English", "English"], ["da", "Danish", "Dansk"], ["de", "German", "Deutsch"],
  ["sv", "Swedish", "Svenska"], ["nb", "Norwegian", "Norsk"], ["fi", "Finnish", "Suomi"],
  ["pl", "Polish", "Polski"], ["fr", "French", "Français"], ["nl", "Dutch", "Nederlands"],
  ["et", "Estonian", "Eesti"], ["lv", "Latvian", "Latviešu"], ["lt", "Lithuanian", "Lietuvių"],
  ["hu", "Hungarian", "Magyar"], ["de-AT", "Austrian", "Österreichisch"],
];
const LANG_CODES = LANGUAGES.map(([c]) => c);

const COUNTRIES: Array<[string, string, string]> = [
  ["CN", "China", "zh"], ["BD", "Bangladesh", "bn"], ["IN", "India", "hi"], ["TR", "Turkey", "tr"],
  ["PK", "Pakistan", "ur"], ["VN", "Vietnam", "vi"], ["KH", "Cambodia", "km"], ["PT", "Portugal", "pt"],
  ["DK", "Denmark", "da"], ["DE", "Germany", "de"], ["SE", "Sweden", "sv"], ["NO", "Norway", "nb"],
  ["FI", "Finland", "fi"], ["PL", "Poland", "pl"], ["LT", "Lithuania", "lt"],
];
// Production origin mix — mostly Asian factories.
const ORIGIN_WEIGHTS: Array<[string, number]> = [
  ["China", 48], ["Bangladesh", 20], ["India", 9], ["Turkey", 8], ["Pakistan", 6], ["Vietnam", 5], ["Cambodia", 3], ["Portugal", 1],
];

// Pseudo-translation: deterministic, roughly the same length as a real one.
const tr = (lang: string, s: string) => `${s} [${lang}]`;
const translationsFor = (s: string) => Object.fromEntries(LANG_CODES.filter((c) => c !== "en").map((c) => [c, tr(c, s)]));

const svgOf = (label: string, extra = 0) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>${label}</title>` +
  `<path d="M10 10 L90 10 L90 90 L10 90 Z" fill="none" stroke="#000" stroke-width="4"/>` +
  Array.from({ length: 6 + extra }, (_, i) => `<path d="M${15 + i * 7} 20 C ${20 + i * 5} ${40 + i}, ${60 - i} ${70 - i * 2}, ${80 - i * 3} 80" fill="none" stroke="#000" stroke-width="2"/>`).join("") +
  `<text x="50" y="96" font-size="8" text-anchor="middle">${label}</text></svg>`;

// Business areas as Monday labels them. "–" is a real BusinessArea row in the
// live DB (the blank status label); "PL" is a merged alias of Private Label.
const BUSINESS_AREAS = ["Private Label", "License", "Body Guide", "Accessories", "Loved", "T2C", "Coop 365", "Home", "–", "Outlet"];
const BA_TOKEN: Record<string, string> = {
  "Private Label": "private-label",
  License: "license",
  "Body Guide": "body-guide",
  Accessories: "accessories",
  Loved: "loved",
  T2C: "t2c",
  "Coop 365": "private-label",
};

// 40 customers (names from scripts/customer-mapping-backup.json). `prefix`
// links a customer to its coded print-spec variants in the template registry;
// `bas` are the business areas it orders under (= its prod specs); `weight` is
// its share of the style book. Several JYSK / Netto / COOP entities share a
// leading token, which is what makes the import scan's ambiguous bucket real.
type CustomerSpec = { name: string; prefix?: string; bas: string[]; weight: number; skipDelivery?: boolean };
const CUSTOMERS: CustomerSpec[] = [
  { name: "Netto ApS & Co. KG", prefix: "netto-de", bas: ["Private Label", "License", "Body Guide"], weight: 14 },
  { name: "Netto DK (fakt kto)", prefix: "netto-dk", bas: ["Private Label", "License", "Body Guide"], weight: 12 },
  { name: "Netto Sp. z o.o.", bas: ["Private Label"], weight: 2 },
  { name: "Netto Marknad AB", bas: ["Private Label", "License"], weight: 2 },
  { name: "COOP Danmark (fakt kto)", prefix: "coop-dk", bas: ["License", "Accessories", "Loved"], weight: 8 },
  { name: "COOP Danmark (Coop 365)", prefix: "coop-365", bas: ["Coop 365"], weight: 3 },
  { name: "Coop Norge Handel AS", bas: ["Private Label"], weight: 2 },
  { name: "DOLLARSTORE APS", prefix: "dollarstore", bas: ["Private Label", "License"], weight: 6 },
  { name: "Europris AS", prefix: "europris", bas: ["Private Label", "T2C"], weight: 5 },
  { name: "Ge-kås Ullared AB", prefix: "ge-kas", bas: ["Private Label", "License"], weight: 4 },
  { name: "Kaufland Dienstleistung GmbH & Co. KG", prefix: "kaufland", bas: ["Private Label", "License"], weight: 5 },
  { name: "Otto's AG Zentrallager", prefix: "ottos", bas: ["Private Label", "License"], weight: 3 },
  { name: "REMA 1000 Danmark A/S", prefix: "rema-1000", bas: ["Private Label", "License"], weight: 4 },
  { name: "Runsven AB", prefix: "runsven", bas: ["Private Label", "License"], weight: 3 },
  { name: "SOK Palveluässä", prefix: "sok", bas: ["Private Label", "License"], weight: 3 },
  { name: "Tokmanni Oy", prefix: "tokmanni", bas: ["Private Label", "License"], weight: 4 },
  { name: "JYSK A/S", bas: ["Home", "Private Label"], weight: 3 },
  { name: "JYSK SE", bas: ["Home"], weight: 1.5 },
  { name: "JYSK AB", bas: ["Home"], weight: 1 },
  { name: "JYSK Kft.", bas: ["Home"], weight: 0.6 },
  { name: "JYSK BV", bas: ["Home"], weight: 0.6 },
  { name: "Lindex AB, c/o Lindex H.K Ltd", bas: ["Private Label"], weight: 1.5 },
  { name: "Rusta AB", bas: ["Private Label", "Home"], weight: 1.5 },
  { name: "Migros", bas: ["License"], weight: 1 },
  { name: "Kondor Sp. z o.o.", bas: ["Private Label"], weight: 0.5 },
  { name: "NORMA", bas: ["Private Label", "License"], weight: 1.5 },
  { name: "NORMAL A/S", bas: ["Private Label"], weight: 1 },
  { name: "ICA Sverige AB", bas: ["License"], weight: 1 },
  { name: "MAXIMA", bas: ["Private Label"], weight: 0.6 },
  { name: "Woolworth GmbH", bas: ["Private Label", "License"], weight: 2, skipDelivery: true },
  { name: "Salling Group A/S", bas: ["Private Label", "License"], weight: 3 },
  { name: "Jula AB", bas: ["Private Label"], weight: 0.6 },
  { name: "Kesko Corp/K-Citymarket", bas: ["License"], weight: 1 },
  { name: "NKD Group GmbH", bas: ["License"], weight: 1 },
  { name: "Bon Prix", bas: ["Private Label"], weight: 0.5 },
  { name: "REWE Zentral AG", bas: ["License"], weight: 0.8 },
  { name: "Harald Nyborg A/S", bas: ["Accessories"], weight: 0.4 },
  { name: "Spar Kjøp AS", bas: ["–"], weight: 0.4 },
  { name: "StylePit.com A/S", bas: ["Private Label"], weight: 0.3 },
  { name: "Matalan (Cooneen).", bas: ["–"], weight: 0.3 },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const COMPOSITIONS = [
  "100% Cotton", "100% Organic Cotton", "95% Cotton 5% Elastane", "57% Cotton 38% Polyester 5% Elastane",
  "60% Recycled Cotton, 40% Polyester.", "100% Polyester", "80% Cotton 20% Polyester",
  "52% Polyester 48% Sheepskin\nLining: 100% Polyester", "100% Cotton, Tulle: 100% Polyester",
  "75% Cotton 22% Polyamide 3% Elastane", "100% Recycled Polyester", "70% Viscose 30% Polyamide",
];
const COLOUR_NAMES = ["Navy", "Black", "White", "Grey Melange", "Dusty Rose", "Olive", "Off White", "Light Blue", "Burgundy", "Sand", "Multi"];
const DESCRIPTION_SENTENCES = [
  "Soft jersey quality with a brushed inside for extra comfort.",
  "Elastic waistband with an inner drawstring.",
  "All-over print on the front panel, plain back.",
  "Ribbed cuffs and neckline, flatlock seams.",
  "Delivered folded in an individual polybag with a size sticker.",
  "Assortment packed per colour, master carton with assortment label.",
  "Fits true to size; the size chart follows the customer's standard grading.",
  "The licensed artwork must follow the licensor's style guide.",
  "Reinforced heel and toe, comfort cuff without elastic marks.",
  "Two-pack with matching colourways; each piece carries its own care label.",
];
const COMMENT_LINES = [
  "Info Area: Yes.",
  "Customer requires mock-up before bulk production.",
  "Care label to be sewn into the left side seam, 8 cm above hem.",
  "Hangtag attached with a 12 cm loop pin through the care label.",
  "Price sticker on the back of the hangtag, bottom right corner.",
  "Carton marking on two opposite sides of the master carton.",
  "PPS approved 2026-05-04 — proceed with bulk.",
  "Buyer asked to move the barcode 5 mm up on the banderole.",
  "Remember the license holographic sticker on every unit.",
  "Use the updated size chart from the customer's portal.",
  "Supplier confirmed fabric shrinkage < 3% after wash test.",
];
const SIZE_RUNS: string[][] = [
  ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL"],
  ["86/92", "98/104", "110/116", "122/128", "134/140", "146/152", "158/164", "170/176"],
  ["35-38", "39-42", "43-46", "31-34", "27-30", "23-26", "19-22", "47-50"],
  ["S/M", "L/XL", "XXL", "3XL", "4XL", "5XL", "XS", "6XL"],
  ["50/56", "62/68", "74/80", "86/92", "98/104", "110/116", "122/128", "134/140"],
];
const FIRST_NAMES = ["Mette", "Lars", "Sofie", "Jonas", "Ida", "Mikkel", "Anna", "Kasper", "Line", "Thomas"];
const LAST_NAMES = ["Hansen", "Jensen", "Nielsen", "Pedersen", "Andersen", "Christensen", "Larsen", "Sørensen"];
const SUPPLIER_CITIES = ["Ningbo", "Shaoxing", "Dhaka", "Chittagong", "Tirupur", "Istanbul", "Karachi", "Ho Chi Minh", "Phnom Penh", "Guangzhou", "Hangzhou", "Lahore"];
const SUPPLIER_WORDS = ["Jinyuan", "Golden", "Evergreen", "Sunrise", "Pacific", "Harbour", "Lotus", "Silk Road", "Bright", "Unity"];
const SUPPLIER_KINDS = ["Textile Co., Ltd.", "Garments Ltd.", "Knitwear Ltd.", "Apparel Industries", "Fashion Co.", "Exports Pvt Ltd"];
const CITY_COUNTRY: Record<string, string> = {
  Ningbo: "China", Shaoxing: "China", Guangzhou: "China", Hangzhou: "China", Dhaka: "Bangladesh",
  Chittagong: "Bangladesh", Tirupur: "India", Istanbul: "Turkey", Karachi: "Pakistan", Lahore: "Pakistan",
  "Ho Chi Minh": "Vietnam", "Phnom Penh": "Cambodia",
};
const REJECT_REASONS = [
  "Wrong composition — the 2nd composition line is missing.",
  "Barcode doesn't match the PO for size M.",
  "Logo too close to the edge, needs 3 mm margin.",
  "Danish translation of the care text is wrong.",
  "Carton quantity should be 12, not 24.",
  "Country of origin must read 'Made in Bangladesh'.",
];

// ---------------------------------------------------------------------------
// Entity shapes kept in memory between phases (no rawData — that's built per
// insert chunk so the 75 MB of JSON never sits in the heap at once).
// ---------------------------------------------------------------------------

type CustomerRow = { id: string; mondayItemId: string; name: string; spec: CustomerSpec; index: number };
type BaRow = { id: string; mondayValue: string };
type SupplierRow = { id: string; mondayItemId: string; name: string; country: string; email: string; sharepointUrl: string | null };
type VariantMeta = { key: string; docType: string; name: string; widthMm: number; heightMm: number; multiDoc: boolean; layoutVersion: number | null };
type ProdSpecRow = {
  id: string;
  name: string;
  customer: CustomerRow;
  ba: BaRow;
  outputs: ProdSpecOutput[];
  active: boolean;
  hasGeneralInfo: boolean;
  weight: number;
};
type StyleRow = {
  index: number;
  id: string;
  facts: ItemFacts;
  customer: CustomerRow;
  ba: BaRow | null;
  prodSpec: ProdSpecRow | null;
  supplier: SupplierRow | null;
  poNumber: string | null;
  poSeq: number | null;
  createdAt: Date;
  updatedAt: Date;
  groupTitle: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
  eanStatus: string;
  hasJobs: boolean;
  status: string;
  cartonEan: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertChunked<T>(label: string, rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
  console.log(`  ${label}: ${rows.length}`);
}

function assertLocalDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const host = new URL(url).hostname;
  if (!FORCE && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing to truncate a non-local database (${host}). Pass --force if you really mean it.`);
  }
}

// Tables the seed owns. Truncated together (CASCADE) so FK order doesn't
// matter; doc_types / trim_concept_rows are migration-seeded and kept.
const OWNED_TABLES = [
  "job_assets", "jobs", "logs", "review_actions", "rejection_attachments", "rejection_tickets",
  "user_notifications", "supplier_send_queue_items", "supplier_send_batches", "supplier_shares",
  "output_deliveries", "style_output_ignores", "style_output_field_values", "style_output_line_values",
  "style_manual_trim_uploads", "style_views", "style_eans", "styles", "prod_spec_suppliers",
  "prod_spec_images", "prod_specs", "templates", "output_layouts", "customer_business_area_combos",
  "customers", "business_areas", "supplier_contacts", "suppliers", "languages", "countries",
  "wash_symbols", "certificates", "care_labels", "info_area_sizes", "qr_images", "translations",
  "monday_ghost_dropdown_options", "monday_ghost_columns", "monday_ghost_items", "monday_ghost_boards",
  "app_settings", "user_presence", "email_logs", "email_events", "cron_runs", "bulk_run_batches",
  "sessions", "accounts",
];

// A tiny but valid PDF. The pdf column is never read by the list pages (they
// select around it), so size only matters for the preview routes — and the
// brief is to keep it small.
const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 255]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function truncate() {
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${OWNED_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  await db.user.deleteMany({ where: { id: { not: ADMIN_ID } } });
}

async function seedUsers() {
  // The dev auth bypass (AUTH_DISABLED) runs as the OLDEST ADMIN, so perf-admin
  // must stay the only/oldest admin — everyone else is a REVIEWER created later.
  const existing = await db.user.findUnique({ where: { id: ADMIN_ID } });
  if (!existing) {
    await db.user.create({
      data: {
        id: ADMIN_ID,
        email: "admin@perf.local",
        name: "Perf Admin",
        role: "ADMIN",
        emailVerified: true,
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
  }
  await db.user.createMany({
    data: REVIEWERS.map((r, i) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: "REVIEWER" as const,
      emailVerified: true,
      createdAt: new Date(Date.UTC(2025, 1, 1 + i)),
    })),
  });
  await db.userPresence.create({ data: { userId: ADMIN_ID, lastSeenAt: NOW } });
}

async function seedCatalogues() {
  await db.language.createMany({
    data: LANGUAGES.map(([code, name, nativeName], i) => ({ id: `perf-lang-${code}`, code, name, nativeName, sortOrder: i })),
  });
  await db.country.createMany({
    data: COUNTRIES.map(([code, nameEn, languageCode]) => ({
      id: `perf-country-${code}`,
      code,
      nameEn,
      languageCode,
      mondayValue: nameEn,
      nameTranslations: translationsFor(nameEn),
    })),
  });

  const actionOf = (label: string) =>
    /wash/i.test(label) ? "WASHING" : /bleach/i.test(label) ? "BLEACHING" : /tumble/i.test(label) ? "TUMBLE_DRYING" : /iron/i.test(label) ? "IRONING" : /clean/i.test(label) ? "DRY_CLEANING" : null;
  await db.washSymbol.createMany({
    data: WASH_CARE_LABELS.map((label, i) => ({
      id: `perf-wash-${pad(i, 2)}`,
      code: slugify(label).replace(/-/g, "_"),
      name: label,
      svg: svgOf(label, 10),
      mondayValue: label,
      translations: { en: label, ...translationsFor(label) },
      action: actionOf(label),
      restrictive: /^do not/i.test(label),
    })),
  });
  await db.certificate.createMany({
    data: CERTIFICATES.map((name, i) => ({ id: `perf-cert-${i}`, name, logo: svgOf(name, 20) })),
  });
  const careLines: Array<[string, string | null]> = [
    ["Wash with similar colours", "WASHING"], ["Wash inside out", "WASHING"], ["Do not soak", "WASHING"],
    ["Iron inside out", "IRONING"], ["Do not iron on print", "IRONING"], ["Reshape while damp", null],
    ["Dry flat", "TUMBLE_DRYING"], ["Wash before first use", "WASHING"], ["Keep away from fire", null],
    ["Colour may transfer, wash separately", "WASHING"], ["Do not use fabric softener", "WASHING"],
    ["Line dry in shade", "TUMBLE_DRYING"], ["Remove promptly after washing", null], ["Cool iron if needed", "IRONING"],
    ["Do not wring", "WASHING"], ["Professional cleaning recommended", "DRY_CLEANING"],
  ];
  await db.careLabel.createMany({
    data: careLines.map(([sourceText, action], i) => ({
      id: `perf-care-${pad(i, 2)}`,
      sourceText,
      sortOrder: i,
      action: action as "WASHING" | null,
    })),
  });
  await db.infoAreaSize.createMany({
    data: [
      ["Small", 40, 30], ["Medium", 60, 40], ["Large", 80, 60], ["Banderole strip", 27.5, 120],
    ].map(([name, widthMm, heightMm], i) => ({ id: `perf-ias-${i}`, name: String(name), widthMm: Number(widthMm), heightMm: Number(heightMm) })),
  });
  await db.qrImage.createMany({
    data: ["Product passport", "Recycling info"].map((name, i) => ({
      id: `perf-qr-${i}`,
      name,
      image: `data:image/svg+xml;base64,${Buffer.from(svgOf(name, 30)).toString("base64")}`,
    })),
  });

  // Translation dictionary: care phrases, fibres, "Made in" lines, product words.
  const phrases = new Set<string>();
  for (const l of WASH_CARE_LABELS) phrases.add(l);
  for (const [l] of careLines) phrases.add(l);
  for (const [, n] of COUNTRIES) phrases.add(`Made in ${n}`);
  for (const f of ["Cotton", "Organic Cotton", "Polyester", "Recycled Polyester", "Elastane", "Viscose", "Polyamide", "Sheepskin", "Lining", "Tulle", "Outer Fabric", "Recycled Cotton"]) phrases.add(f);
  for (const g of PRODUCT_GROUPS) phrases.add(g);
  for (const t of TRIMS) phrases.add(t);
  const r = rngFor("translations");
  while (phrases.size < 380) phrases.add(`${r.pick(DESCRIPTION_SENTENCES).split(" ").slice(0, r.int(2, 6)).join(" ")} ${phrases.size}`);
  const rows = [...phrases].map((sourceText, i) => ({
    id: `perf-tr-${pad(i, 4)}`,
    key: sourceText.toLowerCase().replace(/\s+/g, " ").trim(),
    sourceText,
    translations: translationsFor(sourceText),
    category: i % 7 === 0 ? "translation new words" : "Translations",
    mondayItemId: String(9_671_600_000 + i),
    lastSyncedAt: minutesAgo(60 * 24 * 3),
  }));
  await insertChunked("translations", rows, 500, (chunk) => db.translation.createMany({ data: chunk }));
}

async function seedCustomersAndSuppliers() {
  const customers: CustomerRow[] = CUSTOMERS.map((spec, i) => ({
    id: `perf-cus-${pad(i, 2)}`,
    mondayItemId: String(3_317_900_000 + i * 17),
    name: spec.name,
    spec,
    index: i,
  }));
  await db.customer.createMany({
    data: customers.map((c, i) => {
      const r = rngFor(`customer:${i}`);
      // A handful of real per-customer mapping overrides on top of the global
      // Pre-Order defaults, plus the required-field set completion is scored on.
      const config = {
        mondayBoardIds: [],
        columnMapping: r.chance(0.3) ? { colourName: "text_mktbynx8", countryOfOrigin: "mirror__1" } : {},
        requiredFields: [
          { id: "text64__1", label: "Composition" },
          { id: "dropdown_mktbzd1f", label: "Wash Care Symbols" },
          { id: "sizes__1", label: "Sizes" },
          { id: "text44__1", label: "PO Number" },
          ...(r.chance(0.5) ? [{ id: "text91__1", label: "Customer Item No" }] : []),
        ],
        skipSupplierDelivery: c.spec.skipDelivery === true,
        ...(r.chance(0.2) ? { logoUrl: `https://cdn.example.com/logos/${slugify(c.name)}.svg` } : {}),
      };
      parseCustomerConfig(config); // throws if the shape ever drifts from the app's schema
      return {
        id: c.id,
        slug: slugify(c.name),
        mondayItemId: c.mondayItemId,
        name: c.name,
        priority: r.pick(["A", "B", "C"]),
        salesResponsible: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}`,
        country: r.pick(["Denmark", "Germany", "Sweden", "Norway", "Finland", "Poland"]),
        location: r.pick(["Copenhagen", "Hamburg", "Stockholm", "Oslo", "Helsinki", "Warsaw"]),
        lastSyncedAt: minutesAgo(60 * 6),
        config,
      };
    }),
  });

  const bas: BaRow[] = BUSINESS_AREAS.map((v, i) => ({ id: `perf-ba-${pad(i, 2)}`, mondayValue: v }));
  await db.businessArea.createMany({
    data: [
      ...bas.map((b) => ({ id: b.id, mondayValue: b.mondayValue, name: b.mondayValue, lastSyncedAt: minutesAgo(600) })),
      { id: "perf-ba-alias-pl", mondayValue: "PL", name: "PL", mergedIntoId: bas[0].id, lastSyncedAt: minutesAgo(600) },
    ],
  });

  // Reference data (customers, suppliers, layouts) stays fixed under --styles.
  const supplierCount = 120;
  const suppliers: SupplierRow[] = Array.from({ length: supplierCount }, (_, i) => {
    const r = rngFor(`supplier:${i}`);
    const city = r.pick(SUPPLIER_CITIES);
    const name = `${city} ${r.pick(SUPPLIER_WORDS)} ${r.pick(SUPPLIER_KINDS)}${i >= 60 ? ` ${i}` : ""}`;
    return {
      id: `perf-sup-${pad(i, 3)}`,
      mondayItemId: String(3_363_300_000 + i * 13),
      name,
      country: CITY_COUNTRY[city],
      email: `orders@${slugify(name).slice(0, 24)}.example.com`,
      sharepointUrl: r.chance(0.9)
        ? `https://contrast.sharepoint.com/sites/Suppliers/Shared%20Documents/${encodeURIComponent(name)}`
        : null,
    };
  });
  await db.supplier.createMany({
    data: suppliers.map((s, i) => {
      const r = rngFor(`supplier-extra:${i}`);
      return {
        id: s.id,
        mondayItemId: s.mondayItemId,
        name: s.name,
        purchaser: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}`,
        address: `${r.int(1, 999)} Industrial Road`,
        location: s.country,
        postCode: r.digits(6),
        country: s.country,
        sharepointUrl: s.sharepointUrl,
        email: s.email,
        contactEmail: r.chance(0.6) ? `merch@${slugify(s.name).slice(0, 24)}.example.com` : null,
        contactName: r.chance(0.6) ? `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}` : null,
        lastSyncedAt: minutesAgo(60 * 6),
      };
    }),
  });
  const contacts = suppliers.flatMap((s, i) => {
    const r = rngFor(`contacts:${i}`);
    return Array.from({ length: r.int(1, 3) }, (_, k) => ({
      id: `perf-con-${pad(i, 3)}-${k}`,
      mondayItemId: String(3_363_269_000_000 + i * 10 + k),
      name: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}`,
      title: r.chance(0.5) ? "Merchandiser" : null,
      email: `contact${k}@${slugify(s.name).slice(0, 24)}.example.com`,
      contactType: r.chance(0.8) ? "Product Supplier" : "Cost Supplier",
      status: r.chance(0.9) ? "Active" : "Passive",
      supplierId: s.id,
      lastSyncedAt: minutesAgo(60 * 6),
    }));
  });
  await insertChunked("supplier_contacts", contacts, 500, (chunk) => db.supplierContact.createMany({ data: chunk }));
  return { customers, bas, suppliers };
}

// Output Builder layouts — published ones register as `layout:<id>` variants
// and are the bulk of what prod specs print today.
async function seedLayouts(customers: CustomerRow[], bas: BaRow[]): Promise<VariantMeta[]> {
  const docTypes = ["CARE_LABEL", "STICKER", "HANGTAG", "CARTON_MARKING", "WASHCARE"];
  const linesFor: Record<string, string[][]> = {
    CARE_LABEL: [["{{style}}", "{{compositionLines}}", "{{careInstructions}}"], ["{{madeIn}}", "PO: {{orderNo}}", "{{washSymbols}}"]],
    STICKER: [["{{customerItemNo}}", "{{sizes}}", "{{barcode:ean13}}", "{{description}}"]],
    HANGTAG: [["{{description}}", "{{sizes}}"], ["{{barcode:ean13}}", "{{customerItemNo}}"]],
    CARTON_MARKING: [["{{description}}", "Qty: {{qtyPerCarton}}", "Order: {{orderNo}}", "{{barcode:cartonEan}}"]],
    WASHCARE: [["{{compositionLines}}", "{{washSymbols}}", "{{madeIn}}"]],
  };
  const total = 36;
  const metas: VariantMeta[] = [];
  const rows = Array.from({ length: total }, (_, i) => {
    const r = rngFor(`layout:${i}`);
    const docType = docTypes[i % docTypes.length];
    const published = i < 30;
    // Two published layouts repeat per size and split per file — the
    // "<key>#<suffix>" multi-document outputs.
    const multiDoc = published && i % 15 === 2;
    const [w, h] = docType === "CARTON_MARKING" ? [105, 148] : docType === "STICKER" ? [40, 60] : [35, r.pick([66, 90])];
    const pages = linesFor[docType].map((pageLines, p) => ({
      id: `p${p + 1}`,
      title: p === 0 ? "Front" : "Back",
      widthMm: w,
      heightMm: h,
      margins: { topMm: 2, rightMm: 2, bottomMm: 2, leftMm: 2 },
      sewingLines: docType === "CARE_LABEL" ? [{ edge: "top", offsetMm: 7.5 }] : [],
      blocks: [
        { anchor: "top-left", cols: 12, fontPt: 7, lines: pageLines },
        { rect: { col: 0, row: 10, colSpan: 12, rowSpan: 2 }, align: "center", fontPt: 5, lines: ["{{logo:contrast}}"] },
      ],
    }));
    const definition = {
      pages,
      settings: {
        repeatBy: multiDoc ? "size" : "none",
        splitBy: "ean",
        fileName: r.chance(0.3) ? "{{style}}-{{orderNo}}" : "",
        rules: r.chance(0.2) ? [{ field: "productGroup", op: "contains", keywords: ["socks", "shoes"], mode: "exclude" }] : [],
      },
    };
    parseLayoutDef(definition); // throws if the shape drifts from LayoutDefSchema
    const id = `perf-lay-${pad(i, 2)}`;
    const customer = customers[i % customers.length];
    const version = published ? r.int(1, 9) : 0;
    const name = `${customer.name.split(" ")[0]} ${docType.toLowerCase().replace(/_/g, " ")} ${i}`;
    if (published) {
      metas.push({ key: `layout:${id}`, docType, name, widthMm: w, heightMm: h, multiDoc, layoutVersion: version });
    }
    return {
      id,
      name,
      docType,
      definition,
      status: published ? ("PUBLISHED" as const) : ("DRAFT" as const),
      version,
      autoApprove: r.chance(0.1),
      customerId: customer.id,
      businessAreaId: bas[i % 3].id,
      createdAt: minutesAgo(60 * 24 * r.int(30, 300)),
      updatedAt: minutesAgo(60 * 24 * r.int(1, 30)),
    };
  });
  await db.outputLayout.createMany({ data: rows });
  console.log(`  output_layouts: ${rows.length}`);
  return metas;
}

async function seedProdSpecs(
  customers: CustomerRow[],
  bas: BaRow[],
  suppliers: SupplierRow[],
  layouts: VariantMeta[],
): Promise<ProdSpecRow[]> {
  const coded: VariantMeta[] = TEMPLATE_VARIANTS.map((v) => ({
    key: v.key,
    docType: v.docType,
    name: v.name,
    widthMm: v.defaultWidthMm,
    heightMm: v.defaultHeightMm,
    multiDoc: false,
    layoutVersion: null,
  }));
  const baByValue = new Map(bas.map((b) => [b.mondayValue, b]));
  const specs: ProdSpecRow[] = [];
  let n = 0;
  for (const c of customers) {
    for (const baValue of c.spec.bas) {
      const r = rngFor(`prodspec:${c.index}:${baValue}`);
      const ba = baByValue.get(baValue)!;
      const baToken = BA_TOKEN[baValue];
      // The customer's own coded print specs first (prefix + BA match), then
      // its Output Builder layouts, then generic fillers — the mix a real
      // spec ends up with after a few rounds of editing.
      const own = c.spec.prefix
        ? coded.filter((v) => v.key.startsWith(`${c.spec.prefix}-`) && (!baToken || v.key.includes(baToken)))
        : [];
      const ownLayouts = layouts.filter((l) => l.name.startsWith(c.name.split(" ")[0]));
      const k = r.int(3, 8);
      const chosen = new Map<string, VariantMeta>();
      for (const v of r.sample(own, Math.ceil(k / 2))) chosen.set(v.key, v);
      for (const v of r.sample(ownLayouts, 2)) if (chosen.size < k) chosen.set(v.key, v);
      while (chosen.size < k) {
        const v = r.chance(0.6) ? r.pick(layouts) : r.pick(coded);
        chosen.set(v.key, v);
      }
      const outputs: ProdSpecOutput[] = [...chosen.values()].map((v) => ({
        variantKey: v.key,
        widthMm: v.widthMm,
        heightMm: v.heightMm,
        enabled: r.chance(0.93),
        ...(r.chance(0.1) ? { fieldOverrides: { lot: "N/A" } } : {}),
        ...(v.docType === "CARTON_MARKING" && r.chance(0.3) ? { cartonBarcodeType: "ean13" as const, cartonBarcodeHeightMm: 18 } : {}),
      }));
      ProdSpecOutputsSchema.parse(outputs);
      const weight = c.spec.weight / c.spec.bas.length;
      specs.push({
        id: `perf-ps-${pad(n++, 2)}`,
        name: `${c.name} · ${baValue}`,
        customer: c,
        ba,
        outputs,
        // The smallest combos are auto-created scaffolds nobody has configured
        // yet — they feed the import bell's "needs configuration" count.
        active: !(weight < 0.7 && r.chance(0.6)),
        hasGeneralInfo: r.chance(0.25),
        weight,
      });
    }
  }
  await db.prodSpec.createMany({
    data: specs.map((s) => {
      const r = rngFor(`prodspec-extra:${s.id}`);
      return {
        id: s.id,
        customerId: s.customer.id,
        businessAreaId: s.ba.id,
        name: s.name,
        outputs: s.outputs,
        logoSvg: r.chance(0.4) ? svgOf(s.name, 40) : null,
        generalInfoMd: s.hasGeneralInfo
          ? `# General information\n\n${Array.from({ length: 12 }, () => `- ${r.pick(DESCRIPTION_SENTENCES)}`).join("\n")}\n\n| Test | Standard |\n|---|---|\n| Colour fastness | ISO 105-C06 |\n| Shrinkage | ISO 6330 |\n`
          : null,
        careInstructionsByLang: r.chance(0.5) ? { en: "Wash with similar colours", da: "Vaskes med lignende farver", de: "Mit ähnlichen Farben waschen" } : {},
        outputLanguages: r.sample(LANG_CODES, r.int(3, 9)),
        active: s.active,
        fullyApproved: s.active && r.chance(0.2),
        createdAt: minutesAgo(60 * 24 * r.int(120, 500)),
        updatedAt: minutesAgo(60 * 24 * r.int(1, 60)),
      };
    }),
  });
  const links = specs.flatMap((s) => {
    const r = rngFor(`prodspec-suppliers:${s.id}`);
    return r.sample(suppliers, r.int(2, 6)).map((sup) => ({ id: `${s.id}-${sup.id}`, prodSpecId: s.id, supplierId: sup.id }));
  });
  await db.prodSpecSupplier.createMany({ data: links });
  console.log(`  prod_specs: ${specs.length} (${specs.filter((s) => !s.active).length} unconfigured), prod_spec_suppliers: ${links.length}`);
  return specs;
}

function buildFacts(
  i: number,
  r: Rng,
  customer: CustomerRow,
  ba: BaRow | null,
  supplier: SupplierRow | null,
  name: string,
  poNumber: string,
  groupId: string,
  groupTitle: string,
  createdAt: Date,
  updatedAt: Date,
  blank: Set<string>,
  mondayItemId: string,
): ItemFacts {
  const run = r.pick(SIZE_RUNS);
  const sizes = run.slice(0, r.int(5, 8));
  const eanBase = `57${pad(i % 1_000_000, 6)}${r.digits(4)}`;
  const cartonEan = ean13(`${eanBase.slice(0, 11)}9`);
  const productGroup = r.pick(PRODUCT_GROUPS);
  const comments = Array.from({ length: r.int(5, 16) }, () => r.pick(COMMENT_LINES));
  if (customer.name.startsWith("Salling") && r.chance(0.5)) {
    comments.unshift(`TEXT ON LABEL:\n${r.pick(WASH_CARE_LABELS)}. ${r.pick(COMMENT_LINES)}`);
  }
  return {
    mondayItemId,
    name,
    groupId,
    groupTitle,
    createdAt,
    updatedAt,
    customer: { mondayItemId: customer.mondayItemId, name: customer.name },
    supplier: supplier ? { mondayItemId: supplier.mondayItemId, name: supplier.name, country: supplier.country } : null,
    businessArea: ba?.mondayValue ?? "",
    poNumber,
    folderUrl: `https://contrast.sharepoint.com/sites/Styles/Shared%20Documents/${customer.name.split(" ")[0]}/${name}`,
    composition: r.pick(COMPOSITIONS),
    composition2: r.chance(0.2) ? r.pick(COMPOSITIONS) : "",
    colourName: r.pick(COLOUR_NAMES),
    colourCode: r.pick(COLOUR_CODES),
    certificates: r.sample(CERTIFICATES, r.int(0, 2)),
    countryOfOrigin: supplier?.country ?? ORIGIN_WEIGHTS[r.weighted(ORIGIN_WEIGHTS.map(([, w]) => w))][0],
    sizes,
    sizeRatio: r.chance(0.6) ? sizes.map(() => r.int(1, 4)).join("-") : "",
    unitOfMeasure: r.chance(0.2) ? "Sets" : r.chance(0.5) ? "PCS" : "",
    washCare: r.sample(WASH_CARE_LABELS, r.int(3, 5)),
    lot: r.chance(0.7) ? r.int(1000, 99999) : null,
    cartonQty: String(r.pick([6, 8, 12, 24, 36, 48])),
    cartonEan,
    klNumber: r.chance(0.5) ? `KL${r.digits(5)}` : "",
    price: r.chance(0.7) ? `${r.int(19, 299)},${r.pick(["00", "95", "99"])} DKK / ${r.int(2, 39)},${r.pick(["00", "95", "99"])} EUR` : "",
    customerItemNo: r.digits(r.int(6, 9)),
    consignmentCode: `ILC0${r.digits(4)}`,
    barcodeNumber: ean13(eanBase),
    batchNo: r.chance(0.4) ? r.int(100, 9999) : null,
    targetGroup: r.pick(TARGET_GROUPS),
    customerOrderNo: r.chance(0.7) ? `${r.digits(7)}` : "",
    deliveryTerm: r.pick(SHIPPING_TERMS),
    description: Array.from({ length: r.int(5, 12) }, () => r.pick(DESCRIPTION_SENTENCES)).join(" "),
    prodNumber: r.chance(0.6) ? r.int(100000, 999999) : null,
    campaignWeek: r.chance(0.6) ? `W${r.int(1, 52)} ${r.pick([2026, 2027])}` : "",
    salesUnit: r.chance(0.5) ? r.pick([1, 2, 3, 5]) : null,
    trims: r.sample(TRIMS, r.int(2, 6)),
    productGroup,
    styleComments: comments.join("\n"),
    internalNotes: Array.from({ length: r.int(1, 6) }, () => r.pick(COMMENT_LINES)).join("\n"),
    labelSupplier: r.pick(["Avery Dennison HK", "Checkpoint Systems", "SML Group", "Trimco", "Nilorn"]),
    qcStatus: r.pick(QC_STATUSES),
    barcodeText: sizes.map((s, k) => `${s}:${ean13(`${eanBase.slice(0, 10)}${pad(k, 2)}`)}`).join(", "),
    cartonBarcodeText: `${sizes.map((s) => `${s}:${cartonEan}`).join(", ")}, Assort - ${cartonEan}`,
    orderQty: r.int(300, 24000),
    orderStatus: r.pick(ORDER_STATUSES),
    sampleStatus: r.pick(SAMPLE_STATUSES),
    artworkStatus: r.pick(ARTWORK_STATUSES),
    season: `${r.pick(["SS", "AW"])}${r.pick([26, 27])}`,
    brand: r.pick(BRANDS),
    factoryStyle: `${r.pick(["FS", "NB", "DK"])}-${r.digits(5)}`,
    fobPrice: r.int(80, 1200) / 100,
    hsCode: `6${r.digits(7)}`,
    weightKg: r.int(30, 180) / 10,
    qcEmail: `qc@${slugify(supplier?.name ?? "supplier").slice(0, 20)}.example.com`,
    purchaser: { id: 41_000_000 + r.int(0, 30), name: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}` },
    customerContact: { id: 42_000_000 + r.int(0, 30), name: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}` },
    subitemIds: Array.from({ length: r.int(3, 9) }, (_, k) => 7_400_000_000 + i * 10 + k),
    rush: r.chance(0.1),
    blank,
  };
}

// Mapped columns a style can be missing on Monday — each one blocks some
// outputs on the readiness walks.
const BLANKABLE: Array<[string, string]> = [
  ["text64__1", "Composition"], ["dropdown_mktbzd1f", "Wash Care Symbols"], ["sizes__1", "Sizes"],
  ["text91__1", "🔑 Customer Item No"], ["retail_prices__1", "Retail Prices"], ["text2__1", "Qty/Carton"],
  ["long_text_mkrvd8j3", "Description"], ["text33__1", "📅 Campaign Week"], ["customer_order_number__1", "🔢 Customer Order Number"],
  ["mirror__1", "🌍 Country of Origin"],
];

const ACTIVE_GROUPS: Array<[string, string, number]> = [
  ["topics", "📦 Pre Orders", 70], ["new_group_behind", "⏰ Behind Schedule", 12], ["group_shipped", "🚢 Shipped", 10], ["group_samples", "🧵 Sampling", 8],
];

function planStyles(customers: CustomerRow[], bas: BaRow[], suppliers: SupplierRow[], specs: ProdSpecRow[]): StyleRow[] {
  const specWeights = specs.map((s) => s.weight * (s.active ? 1 : 0.15));
  const styles: StyleRow[] = [];
  const baBlank = bas.find((b) => b.mondayValue === "–")!;
  for (let i = 0; i < STYLE_COUNT; i++) {
    const r = rngFor(`style:${i}`);
    const age = 1 - i / STYLE_COUNT; // 1 = oldest, 0 = newest
    let spec: ProdSpecRow | null = specs[r.weighted(specWeights)];
    let customer = spec.customer;
    let ba: BaRow | null = spec.ba;
    if (r.chance(0.02)) {
      // No business area on Monday → no BA, no prod spec (ingest leaves both null).
      spec = null;
      ba = null;
      customer = customers[r.weighted(customers.map((c) => c.spec.weight))];
    } else if (spec.ba.id === baBlank.id && r.chance(0.5)) {
      ba = baBlank;
    }
    const supplier = r.chance(0.95) ? suppliers[r.int(0, suppliers.length - 1)] : null;

    // Contrast IL-codes; ~4% reuse an earlier style's name on a different PO
    // (the lookalike rows) and ~3% are 2-pack names.
    let name = `IL${10000 + ((i * 7919 + 1234) % 89990)}${r.chance(0.15) ? r.pick(["I", "K", "B"]) : ""}`;
    if (i > 50 && r.chance(0.04)) name = styles[i - r.int(1, 50)].facts.name;
    else if (r.chance(0.03)) name = `${name}+IL${10000 + ((i * 7919 + 4321) % 89990)}`;

    // Multi-style POs: ~4 styles per PO, newest styles on the highest PO.
    const poSeqRaw = 61900 + Math.floor(i / 4) + r.int(-2, 2);
    const noPo = r.chance(0.04);
    const poNumber = noPo ? (r.chance(0.5) ? null : "") : `C-PO${poSeqRaw}`;
    const createdAt = minutesAgo(Math.round(age * 420 * 24 * 60) + r.int(30, 600));
    const updatedAt = minDate(addMinutes(createdAt, r.int(60, 60 * 24 * 40)), minutesAgo(r.int(5, 120)));

    // Done-group share grows with age; a sliver of Templates / Cancelled.
    let groupId: string;
    let groupTitle: string;
    if (r.chance(0.32 * age)) [groupId, groupTitle] = ["group_done", "✅ Done"];
    else if (r.chance(0.025)) [groupId, groupTitle] = ["group_cancelled", "Cancelled"];
    else if (r.chance(0.006)) [groupId, groupTitle] = ["group_templates", "📋 Templates"];
    else {
      const g = ACTIVE_GROUPS[r.weighted(ACTIVE_GROUPS.map(([, , w]) => w))];
      [groupId, groupTitle] = [g[0], g[1]];
    }
    const archivedAt = r.chance(0.02) ? addMinutes(updatedAt, 60) : null;
    const deletedAt = !archivedAt && r.chance(0.006) ? addMinutes(updatedAt, 90) : null;

    // ~30% of the book is missing 1–3 mapped Monday fields.
    const blank = new Set<string>();
    if (r.chance(0.3)) for (const [id] of r.sample(BLANKABLE, r.int(1, 3))) blank.add(id);

    const mondayItemId = String(7_000_000_000 + i * 13 + 4211);
    const facts = buildFacts(i, r, customer, ba, supplier, name, poNumber ?? "", groupId, groupTitle, createdAt, updatedAt, blank, mondayItemId);

    let eanStatus = "NONE";
    if (poNumber) {
      const statuses: Array<[string, number]> = [
        ["RESOLVED", 70], ["RESOLVED_FROM_MONDAY", 5], ["PARTIAL", 5], ["PENDING", 5], ["PO_NOT_FOUND", 5],
        ["PO_FOUND_NO_EANS", 4], ["STYLE_NOT_IN_PO", 2], ["ERROR", 2], ["RESOLVING", 0.5],
      ];
      eanStatus = statuses[r.weighted(statuses.map(([, w]) => w))][0];
    }

    const inFlow = !archivedAt && !deletedAt && !!poNumber && spec?.active === true;
    const hasJobs = inFlow ? r.chance(blank.size === 0 ? 0.9 : 0.55) : !!spec && r.chance(0.12);

    styles.push({
      index: i,
      id: `perf-sty-${pad(i, 5)}`,
      facts,
      customer,
      ba,
      prodSpec: spec,
      supplier,
      poNumber,
      poSeq: parsePoNumberValue(poNumber),
      createdAt,
      updatedAt,
      groupTitle,
      archivedAt,
      deletedAt,
      eanStatus,
      hasJobs,
      status: blank.size === 0 ? "READY" : "PENDING",
      cartonEan: ["RESOLVED", "RESOLVED_FROM_MONDAY", "PARTIAL"].includes(eanStatus) && r.chance(0.85) ? facts.cartonEan : null,
    });
  }
  return styles;
}

function poScrapeSnapshot(s: StyleRow, r: Rng): object {
  const sectionCount = r.int(3, 10);
  const selectedAt = r.int(0, sectionCount - 1);
  const sections = Array.from({ length: sectionCount }, (_, k) => {
    const styleNumber = k === selectedAt ? s.facts.name : `IL${r.digits(5)}`;
    const sizes = k === selectedAt ? s.facts.sizes : SIZE_RUNS[k % SIZE_RUNS.length].slice(0, r.int(4, 7));
    return {
      styleNumber,
      contrastNo: `ILC0${r.digits(4)}`,
      selected: k === selectedAt,
      cartonEan: ean13(`57${r.digits(10)}`),
      variants: sizes.map((size) => ({ label: `${s.facts.colourName} / ${size}`, ean13: ean13(`57${r.digits(10)}`), used: k === selectedAt })),
    };
  });
  return {
    version: 1,
    scrapedAt: addMinutes(s.createdAt, 60 * 24).toISOString(),
    poFileName: `${s.poNumber}.pdf`,
    poFileWebUrl: `https://contrast.sharepoint.com/sites/Suppliers/Shared%20Documents/PO/${s.poNumber}.pdf`,
    sections,
    sectionCount,
    truncated: false,
    styleSizes: s.facts.sizes,
    matchedByCustomerItemNo: r.chance(0.3),
    matchedByStyleNumber: true,
    poStyleNumbers: sections.map((x) => x.styleNumber),
    colourCodeOnStyle: s.facts.colourCode,
    colourLetters: [],
    colourScopeApplied: false,
    variantsExcludedByColour: 0,
  };
}

async function insertStyles(styles: StyleRow[]) {
  let rawBytes = 0;
  const chunkSize = 200;
  for (let i = 0; i < styles.length; i += chunkSize) {
    const chunk = styles.slice(i, i + chunkSize);
    const data: Prisma.StyleCreateManyInput[] = chunk.map((s) => {
      const r = rngFor(`style-row:${s.index}`);
      const rawData = styleRawData(buildPreOrderItem(s.facts));
      rawBytes += JSON.stringify(rawData).length;
      const resolved = ["RESOLVED", "RESOLVED_FROM_MONDAY", "PARTIAL"].includes(s.eanStatus);
      const scraped = resolved || ["PO_FOUND_NO_EANS", "STYLE_NOT_IN_PO"].includes(s.eanStatus);
      const missing = BLANKABLE.filter(([id]) => s.facts.blank.has(id)).map(([id, label]) => ({ id, label }));
      return {
        id: s.id,
        customerId: s.customer.id,
        businessAreaId: s.ba?.id ?? null,
        supplierId: s.supplier?.id ?? null,
        prodSpecId: s.prodSpec?.id ?? null,
        qrImageId: r.chance(0.05) ? "perf-qr-0" : null,
        mondayItemId: s.facts.mondayItemId,
        mondayBoardId: PRE_ORDER_BOARD_ID,
        name: s.facts.name,
        businessArea: s.ba?.mondayValue ?? null,
        poNumber: s.poNumber,
        poSeq: s.poSeq,
        styleFolderUrl: s.facts.folderUrl,
        groupId: s.facts.groupId,
        groupTitle: s.facts.groupTitle,
        rawData,
        completionPct: missing.length === 0 ? 100 : Math.max(40, 100 - missing.length * r.int(8, 15)),
        missingFields: missing,
        status: s.status as Prisma.StyleCreateManyInput["status"],
        eanStatus: s.eanStatus as Prisma.StyleCreateManyInput["eanStatus"],
        cartonEan: s.cartonEan,
        poFileName: scraped ? `${s.poNumber}.pdf` : null,
        eanResolvedAt: s.eanStatus !== "NONE" && s.eanStatus !== "PENDING" ? addMinutes(s.createdAt, 60 * 24) : null,
        eanAttempts: resolved ? 0 : s.eanStatus === "NONE" ? 0 : r.int(1, 6),
        eanQueuedAt: s.poNumber ? addMinutes(s.createdAt, 5) : null,
        eanResolveKey: resolved ? r.hex(16) : null,
        // The scrape dump landed later than EAN resolution itself, so only
        // part of the book carries one.
        poScrapeSnapshot: scraped && r.chance(0.5) ? poScrapeSnapshot(s, r) : undefined,
        pulledForTestAt: s.groupTitle === "✅ Done" && s.index % 199 === 0 ? past(addMinutes(s.updatedAt, 30)) : null,
        lastSyncedAt: s.updatedAt,
        archivedAt: s.archivedAt,
        deletedAt: s.deletedAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    });
    await db.style.createMany({ data });
  }
  console.log(`  styles: ${styles.length} (avg rawData ${(rawBytes / styles.length / 1024).toFixed(1)} KB as JSON text)`);

  const eans = styles.flatMap((s) => {
    if (!["RESOLVED", "RESOLVED_FROM_MONDAY", "PARTIAL"].includes(s.eanStatus)) return [];
    const r = rngFor(`eans:${s.index}`);
    return s.facts.sizes.map((size, position) => ({
      id: `${s.id}-ean-${position}`,
      styleId: s.id,
      position,
      size,
      ean13: s.eanStatus === "PARTIAL" && r.chance(0.3) ? null : ean13(`57${pad(s.index, 6)}${pad(position, 2)}${r.digits(2)}`),
      cartonEan: s.cartonEan ?? s.facts.cartonEan,
      variantLabel: `${s.facts.colourName} / ${size}`,
      excluded: r.chance(0.01),
      manual: r.chance(0.01),
      createdAt: addMinutes(s.createdAt, 60 * 24),
      updatedAt: addMinutes(s.createdAt, 60 * 24),
    }));
  });
  await insertChunked("style_eans", eans, 2000, (chunk) => db.styleEan.createMany({ data: chunk }));
}

// ---------------------------------------------------------------------------
// Jobs, assets and the review trail
// ---------------------------------------------------------------------------

type AssetPlan = Prisma.JobAssetCreateManyInput & { id: string };

async function seedJobs(styles: StyleRow[], variantByKey: Map<string, VariantMeta>) {
  // The review queue: exactly ~80 styles (per 5k) whose newest job awaits
  // review — 10 partially decided/claimed by perf-admin, 10 by perf-reviewer,
  // the rest untouched. Picked among live, in-flow styles.
  const queueSize = Math.max(4, Math.round(80 * SCALE));
  const partialEach = Math.max(1, Math.round(10 * SCALE));
  const eligible = styles.filter(
    (s) =>
      s.hasJobs &&
      s.prodSpec?.active &&
      s.poNumber &&
      !s.archivedAt &&
      !s.deletedAt &&
      !/done|cancel|template/i.test(s.groupTitle) &&
      s.prodSpec.outputs.some((o) => o.enabled),
  );
  const queue = rngFor("review-queue").sample(eligible, queueSize);
  const scenario = new Map<string, "admin" | "reviewer" | "untouched">();
  queue.forEach((s, k) => scenario.set(s.id, k < partialEach ? "admin" : k < partialEach * 2 ? "reviewer" : "untouched"));

  const jobs: Prisma.JobCreateManyInput[] = [];
  const assets: AssetPlan[] = [];
  const logs: Prisma.LogCreateManyInput[] = [];
  const reviewActions: Prisma.ReviewActionCreateManyInput[] = [];
  const tickets: Prisma.RejectionTicketCreateManyInput[] = [];
  const notifications: Prisma.UserNotificationCreateManyInput[] = [];
  const queueItems: Prisma.SupplierSendQueueItemCreateManyInput[] = [];
  const shares: Prisma.SupplierShareCreateManyInput[] = [];
  let jobSeq = 0;
  let assetSeq = 0;

  for (const s of styles) {
    if (!s.hasJobs || !s.prodSpec) continue;
    const r = rngFor(`jobs:${s.index}`);
    const role = scenario.get(s.id);
    const enabled = s.prodSpec.outputs.filter((o) => o.enabled);
    if (enabled.length === 0) continue;
    const nJobs = [1, 2, 3, 4, 5, 6][r.weighted([40, 28, 16, 9, 5, 2])];
    // Awaiting styles: ~a third arrive as a rerun of one or two outputs on top
    // of earlier full runs, so their documents span several jobs.
    const jobCount = role ? (r.chance(0.35) ? Math.max(2, nJobs) : 1) : nJobs;
    const strandedOlderAwaiting = role !== undefined && jobCount >= 2 && r.chance(0.3);

    // Newest job status for styles outside the queue.
    const newestStatus = role
      ? "AWAITING_REVIEW"
      : (["APPROVED", "REJECTED", "FAILED", "QUEUED", "RUNNING"] as const)[r.weighted([74, 14, 9, 2, 1])];
    // Timeline, built backwards from the newest run: awaiting reviews sit in
    // the last fortnight, in-flight jobs minutes ago, settled history earlier.
    // Clamped after the style's creation; both terms rise with k, so the
    // order stays strictly increasing (the dashboards order jobs by createdAt).
    let newestAt =
      newestStatus === "QUEUED" || newestStatus === "RUNNING"
        ? minutesAgo(r.int(1, 20))
        : role
          ? minutesAgo(r.int(30, 60 * 24 * 14))
          : minDate(addMinutes(s.createdAt, r.int(60 * 24, 60 * 24 * 30)), minutesAgo(r.int(5, 60 * 24 * 3)));
    if (newestAt.getTime() < addMinutes(s.createdAt, jobCount * 10 + 5).getTime()) {
      newestAt = minDate(addMinutes(s.createdAt, jobCount * 10 + 5), minutesAgo(1));
    }
    const jobTimes: Date[] = [newestAt];
    for (let k = jobCount - 2; k >= 0; k--) jobTimes.unshift(addMinutes(jobTimes[0], -r.int(60 * 6, 60 * 24 * 20)));
    const jobTime = (k: number) =>
      new Date(Math.max(jobTimes[k].getTime(), addMinutes(s.createdAt, (k + 1) * 10).getTime()));
    const latestByBase = new Map<string, AssetPlan>();
    const styleAssets: AssetPlan[] = [];

    for (let k = 0; k < jobCount; k++) {
      const newest = k === jobCount - 1;
      const jobId = `perf-job-${pad(jobSeq++, 6)}`;
      const full = k === 0 || r.chance(0.1);
      const outputs = full ? enabled : r.sample(enabled, r.chance(0.8) ? 1 : 2);
      let status: string = newest
        ? newestStatus
        : strandedOlderAwaiting && k === jobCount - 2
          ? "AWAITING_REVIEW"
          : (["APPROVED", "REJECTED", "FAILED"] as const)[r.weighted([78, 12, 10])];
      const createdAt = jobTime(k);
      const startedAt = status === "QUEUED" ? null : addMinutes(createdAt, 0.2);
      const finishedAt = ["QUEUED", "RUNNING"].includes(status) ? null : addMinutes(createdAt, r.int(1, 4));
      const settledAt = finishedAt ? new Date(Math.max(past(addMinutes(finishedAt, r.int(30, 60 * 24 * 3))).getTime(), finishedAt.getTime())) : null;
      const decider = r.pick(DECIDERS);

      const jobAssets: AssetPlan[] = [];
      if (!["FAILED", "QUEUED", "RUNNING"].includes(status)) {
        const add = (variantKey: string, docType: string, displayName: string, meta?: VariantMeta) =>
          jobAssets.push({
            id: `perf-ast-${pad(assetSeq++, 7)}`,
            jobId,
            docType,
            variantKey,
            fileName: `${s.facts.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${variantKey.replace(/^layout:/, "").replace("#", "-")}.pdf`,
            displayName,
            pdf: TINY_PDF,
            placeholderCount: 0,
            outputConfigKey: r.hex(12),
            outputContentVersion: meta?.layoutVersion ?? null,
            coverManifestKey: docType === "COVER" ? r.hex(16) : null,
            createdAt: finishedAt!,
            updatedAt: finishedAt!,
          });
        for (const o of outputs) {
          const meta = variantByKey.get(o.variantKey);
          if (!meta) continue;
          if (meta.multiDoc) {
            for (const size of s.facts.sizes) add(`${o.variantKey}#${size.replace(/[^\w.-]+/g, "")}`, meta.docType, `${meta.name} · ${size}`, meta);
          } else {
            add(o.variantKey, meta.docType, `${meta.name} · ${o.widthMm}×${o.heightMm} mm`, meta);
          }
        }
        if (full) {
          add(COVER_VARIANT_KEY, "COVER", "Cover page");
          if (s.prodSpec.hasGeneralInfo) add(GENERAL_INFO_VARIANT_KEY, "GENERAL_INFO", "General information");
        }
        if (jobAssets.length === 0) status = "FAILED";
      }

      // Review state per asset.
      let claimedBy: string | null = null;
      let claimedAt: Date | null = null;
      if (status === "APPROVED" || status === "REJECTED") {
        const rejectIdx = status === "REJECTED" ? r.int(0, jobAssets.length - 1) : -1;
        jobAssets.forEach((a, idx) => {
          a.reviewStatus = idx === rejectIdx ? "REJECTED" : "APPROVED";
          a.reviewedById = decider;
          a.reviewedAt = settledAt;
          if (idx === rejectIdx) a.rejectReason = r.pick(REJECT_REASONS);
        });
        claimedBy = decider;
        claimedAt = past(addMinutes(finishedAt!, 10));
        reviewActions.push({
          id: `${jobId}-ra`,
          jobId,
          userId: decider,
          action: status === "APPROVED" ? "APPROVED" : "REJECTED",
          reason: status === "REJECTED" ? r.pick(REJECT_REASONS) : null,
          createdAt: settledAt!,
        });
      } else if (status === "AWAITING_REVIEW") {
        const owner = newest && role === "admin" ? ADMIN_ID : newest && role === "reviewer" ? REVIEWERS[0].id : null;
        jobAssets.forEach((a) => {
          a.reviewStatus = "PENDING_REVIEW";
          // A few documents carry placeholder artifacts — print-blocked.
          a.placeholderCount = r.chance(0.08) ? r.int(1, 3) : 0;
        });
        if (owner) {
          claimedBy = owner;
          claimedAt = past(addMinutes(finishedAt!, r.int(5, 600)));
          // Partially decided: some documents decided, at least one left.
          const decideCount = r.chance(0.2) ? 0 : r.int(1, Math.max(1, jobAssets.length - 1));
          for (const a of r.sample(jobAssets, decideCount)) {
            a.reviewStatus = r.chance(0.85) ? "APPROVED" : "REJECTED";
            a.reviewedById = owner;
            a.reviewedAt = past(addMinutes(claimedAt, r.int(1, 120)));
            if (a.reviewStatus === "REJECTED") a.rejectReason = r.pick(REJECT_REASONS);
          }
        }
      }

      for (const a of jobAssets) latestByBase.set(a.variantKey!, a);
      assets.push(...jobAssets);
      styleAssets.push(...jobAssets);

      jobs.push({
        id: jobId,
        styleId: s.id,
        prodSpecId: s.prodSpec.id,
        status: status as Prisma.JobCreateManyInput["status"],
        triggerSource: (k === 0
          ? r.pick(["WEBHOOK", "CRON_SWEEP", "MANUAL_BULK", "EAN_RESOLVED", "MANUAL_IMPORT"])
          : full
            ? "MANUAL_RERUN"
            : r.pick(["MANUAL_RERUN", "TICKET_RERUN", "TICKET_FIX", "EAN_RESOLVED"])) as Prisma.JobCreateManyInput["triggerSource"],
        documentTypes: [
          ...new Set(outputs.map((o) => variantByKey.get(o.variantKey)?.docType).filter((d): d is string => !!d)),
        ],
        variantKeys: full ? [] : outputs.map((o) => o.variantKey),
        error: status === "FAILED" ? r.pick(["NO_OUTPUTS: nothing ready to render", "Puppeteer timeout after 60000 ms", "PO folder AMBIGUOUS"]) : null,
        startedAt,
        finishedAt,
        createdAt,
        updatedAt: settledAt ?? finishedAt ?? createdAt,
        reviewClaimedById: claimedBy,
        reviewClaimedAt: claimedAt,
        reviewEndedAt: status === "APPROVED" || status === "REJECTED" ? settledAt : null,
      });
      logs.push(
        { id: `${jobId}-l0`, jobId, level: "INFO", message: "job.started", payload: { variantKeys: full ? "all" : outputs.map((o) => o.variantKey) }, createdAt: startedAt ?? createdAt },
        {
          id: `${jobId}-l1`,
          jobId,
          level: status === "FAILED" ? "ERROR" : "INFO",
          message: status === "FAILED" ? "job.failed" : "job.finished",
          payload: { assets: jobAssets.length, ms: r.int(4000, 90000) },
          createdAt: finishedAt ?? createdAt,
        },
      );

      // In-app feed: a REVIEW_READY row per rendered job for the two main
      // reviewers, resolved once the job settled.
      if (jobAssets.length > 0) {
        for (const userId of [ADMIN_ID, REVIEWERS[0].id]) {
          const open = status === "AWAITING_REVIEW";
          notifications.push({
            id: `${jobId}-n-${userId}`,
            userId,
            type: "REVIEW_READY",
            title: `${s.facts.name} is ready for review`,
            body: `${jobAssets.length} document${jobAssets.length === 1 ? "" : "s"} rendered for ${s.customer.name} · PO ${s.poNumber ?? "—"}`,
            href: `/styles/${s.id}/review`,
            jobId,
            styleId: s.id,
            createdAt: finishedAt!,
            readAt: r.chance(open ? 0.4 : 0.8) ? past(addMinutes(finishedAt!, 30)) : null,
            dismissedAt: !open && r.chance(0.1) ? past(addMinutes(finishedAt!, 60)) : null,
            resolvedAt: open ? null : settledAt,
          });
        }
      }
    }

    // Rejection tickets: one per rejected document; resolved when a later
    // run of the same output was approved, otherwise still being worked.
    for (const a of styleAssets.filter((x) => x.reviewStatus === "REJECTED")) {
      const latest = latestByBase.get(a.variantKey!);
      const resolved = latest !== undefined && latest.id !== a.id && latest.reviewStatus === "APPROVED";
      const st = resolved ? "RESOLVED" : (["OPEN", "IN_PROGRESS", "FIXED"] as const)[r.weighted([50, 20, 30])];
      const ticketId = `perf-tkt-${a.id.slice(9)}`;
      tickets.push({
        id: ticketId,
        status: st,
        styleId: s.id,
        jobId: a.jobId,
        jobAssetId: a.id,
        variantKey: a.variantKey ?? "",
        docType: a.docType,
        outputName: a.displayName ?? a.docType,
        fileName: a.fileName,
        customerName: s.customer.name,
        businessArea: s.ba?.mondayValue ?? null,
        poNumber: s.poNumber,
        styleName: s.facts.name,
        styleNumber: s.facts.mondayItemId,
        comment: a.rejectReason ?? "Rejected",
        reportedById: a.reviewedById ?? ADMIN_ID,
        reopenedCount: r.chance(0.1) ? 1 : 0,
        startedAt: st !== "OPEN" ? past(addMinutes(a.reviewedAt as Date, 60)) : null,
        fixedAt: st === "FIXED" || st === "RESOLVED" ? past(addMinutes(a.reviewedAt as Date, 240)) : null,
        resolvedAt: st === "RESOLVED" ? past(addMinutes(a.reviewedAt as Date, 600)) : null,
        createdAt: a.reviewedAt as Date,
        updatedAt: past(addMinutes(a.reviewedAt as Date, 600)),
      });
      if (st === "FIXED") {
        notifications.push({
          id: `${ticketId}-n`,
          userId: a.reviewedById ?? ADMIN_ID,
          type: "TICKET_FIXED",
          title: `Fixed: ${a.displayName ?? a.docType}`,
          body: `${s.facts.name} — ready for re-review`,
          href: `/styles/${s.id}/review`,
          ticketId,
          styleId: s.id,
          createdAt: past(addMinutes(a.reviewedAt as Date, 240)),
        });
      }
    }

    // Delivery trail for the currently-approved outputs: a send-queue row per
    // (style × output) and the style's durable supplier share.
    const approvedNow = [...latestByBase.values()].filter((a) => a.reviewStatus === "APPROVED" && a.docType !== "GENERAL_INFO");
    if (approvedNow.length > 0) {
      for (const a of approvedNow) {
        const sp = (["UPLOADED", "PENDING", "FAILED", "SKIPPED", "NO_FOLDER", "AMBIGUOUS"] as const)[r.weighted([80, 8, 4, 4, 2, 2])];
        const folder = `https://contrast.sharepoint.com/sites/Suppliers/Shared%20Documents/${encodeURIComponent(s.supplier?.name ?? "x")}/${s.poNumber}/APPROVED%20LAYOUTS`;
        queueItems.push({
          id: `perf-sq-${a.id.slice(9)}`,
          styleId: s.id,
          variantKey: a.variantKey!,
          jobAssetId: a.id,
          docType: a.docType,
          displayName: a.displayName,
          customerId: s.customer.id,
          supplierId: s.supplier?.id ?? null,
          poSeq: s.poSeq,
          sharePointStatus: sp,
          sharePointUrl: sp === "UPLOADED" ? `${folder}/${a.fileName}` : null,
          sharePointFolderUrl: sp === "UPLOADED" ? folder : null,
          sharePointFolderMatches: sp === "AMBIGUOUS" ? JSON.stringify([{ name: `${s.poNumber}`, webUrl: folder }, { name: `${s.poNumber} (2)`, webUrl: `${folder}%20(2)` }]) : null,
          sharePointError: sp === "FAILED" ? "403 · write not granted" : null,
          pushAttempts: sp === "FAILED" ? r.int(1, 3) : sp === "UPLOADED" ? 1 : 0,
          lastPushAt: sp === "PENDING" ? null : past(addMinutes(a.reviewedAt as Date, 5)),
          sharePointVerifiedAt: sp === "UPLOADED" && r.chance(0.6) ? minutesAgo(r.int(60, 60 * 24 * 7)) : null,
          queuedAt: a.reviewedAt as Date,
          sentAt: sp === "UPLOADED" && r.chance(0.9) ? past(addMinutes(a.reviewedAt as Date, 60 * 12)) : null,
          createdAt: a.reviewedAt as Date,
          updatedAt: past(addMinutes(a.reviewedAt as Date, 60 * 12)),
        });
      }
      shares.push({
        id: `perf-share-${s.index}`,
        token: r.hex(40),
        pin: r.digits(4),
        email: s.supplier?.email ?? "orders@unknown.example.com",
        styleId: s.id,
        firstVisitedAt: r.chance(0.6) ? past(addMinutes(approvedNow[0].reviewedAt as Date, 60 * 20)) : null,
        lastVisitedAt: r.chance(0.6) ? minutesAgo(r.int(60, 60 * 24 * 30)) : null,
        visitCount: r.int(0, 12),
        createdAt: approvedNow[0].reviewedAt as Date,
        updatedAt: approvedNow[0].reviewedAt as Date,
      });
    }

    // Stored Style.status follows the newest job (the pipeline owns it then).
    const newestJob = jobs[jobs.length - 1];
    s.status =
      newestJob.status === "QUEUED" || newestJob.status === "RUNNING"
        ? "GENERATING"
        : newestJob.status === "FAILED"
          ? s.status
          : (newestJob.status as string);
  }

  return { jobs, assets, logs, reviewActions, tickets, notifications, queueItems, shares, queueStyleIds: queue.map((q) => q.id) };
}

async function insertJobs(result: Awaited<ReturnType<typeof seedJobs>>) {
  await insertChunked("jobs", result.jobs, 1000, (chunk) => db.job.createMany({ data: chunk }));
  await insertChunked("job_assets", result.assets, 1000, (chunk) =>
    db.jobAsset.createMany({ data: chunk }),
  );
  await insertChunked("logs", result.logs, 2000, (chunk) => db.log.createMany({ data: chunk }));
  await insertChunked("review_actions", result.reviewActions, 2000, (chunk) => db.reviewAction.createMany({ data: chunk }));
  await insertChunked("rejection_tickets", result.tickets, 1000, (chunk) => db.rejectionTicket.createMany({ data: chunk }));
  await insertChunked("user_notifications", result.notifications, 2000, (chunk) => db.userNotification.createMany({ data: chunk }));
  await insertChunked("supplier_send_queue_items", result.queueItems, 1000, (chunk) => db.supplierSendQueueItem.createMany({ data: chunk }));
  await insertChunked("supplier_shares", result.shares, 1000, (chunk) => db.supplierShare.createMany({ data: chunk }));
}

async function seedStyleOverrides(styles: StyleRow[]) {
  const ignores: Prisma.StyleOutputIgnoreCreateManyInput[] = [];
  const values: Prisma.StyleOutputFieldValueCreateManyInput[] = [];
  for (const s of styles) {
    if (!s.prodSpec || s.prodSpec.outputs.length === 0) continue;
    const r = rngFor(`overrides:${s.index}`);
    if (r.chance(0.015)) {
      const o = r.pick(s.prodSpec.outputs);
      ignores.push({ id: `${s.id}-ign`, styleId: s.id, variantKey: o.variantKey, outputName: o.variantKey, createdById: ADMIN_ID, createdAt: addMinutes(s.createdAt, 60 * 48) });
    }
    if (r.chance(0.02)) {
      const o = r.pick(s.prodSpec.outputs);
      values.push({ id: `${s.id}-fv`, styleId: s.id, variantKey: o.variantKey, field: r.pick(["colourName", "composition", "lot"]), value: r.pick(COLOUR_NAMES), updatedById: ADMIN_ID });
    }
  }
  await db.styleOutputIgnore.createMany({ data: ignores });
  await db.styleOutputFieldValue.createMany({ data: values });
  console.log(`  style_output_ignores: ${ignores.length}, style_output_field_values: ${values.length}`);
}

async function seedCombos(styles: StyleRow[], specs: ProdSpecRow[]) {
  const counts = new Map<string, { n: number; example: string }>();
  for (const s of styles) {
    if (!s.ba || s.archivedAt || s.deletedAt || !s.poNumber || /done|template/i.test(s.groupTitle)) continue;
    const key = `${s.customer.id}::${s.ba.id}`;
    const c = counts.get(key) ?? { n: 0, example: s.id };
    c.n++;
    counts.set(key, c);
  }
  const rows = specs.map((p, i) => ({
    id: `perf-combo-${pad(i, 2)}`,
    customerId: p.customer.id,
    businessAreaId: p.ba.id,
    baKey: p.ba.id,
    baLabel: p.ba.mondayValue,
    customerName: p.customer.name,
    status: (i % 23 === 7 ? "NEW" : "REVIEWED") as "NEW" | "REVIEWED",
    notifiedAt: minutesAgo(60 * 24 * 90),
    reviewedAt: i % 23 === 7 ? null : minutesAgo(60 * 24 * 80),
    activeStyleCount: counts.get(`${p.customer.id}::${p.ba.id}`)?.n ?? 0,
    exampleStyleId: counts.get(`${p.customer.id}::${p.ba.id}`)?.example ?? null,
  }));
  await db.customerBusinessAreaCombo.createMany({ data: rows });
  console.log(`  customer_business_area_combos: ${rows.length}`);
}

// Ghost mirror of the Pre-Order board — what the import bell scans
// (src/lib/import/scan.ts). Most items are already promoted to styles; the
// rest spread over every scan bucket: importable, ambiguous customer,
// unmatched customer, blank / unknown business area, new combination, and
// archived groups the scan skips.
async function seedGhosts(styles: StyleRow[], customers: CustomerRow[], bas: BaRow[], suppliers: SupplierRow[], specs: ProdSpecRow[]) {
  const boards = [
    { id: "perf-gb-preorder", mondayBoardId: PRE_ORDER_BOARD_ID, name: "Pre Order 2026", label: "Pre Order" },
    { id: "perf-gb-styles", mondayBoardId: "6979419195", name: "🛍️ Styles", label: "Styles" },
    { id: "perf-gb-customers", mondayBoardId: "3317892788", name: "Customers", label: "Customers" },
    { id: "perf-gb-suppliers", mondayBoardId: "3363275451", name: "Suppliers", label: "Suppliers" },
    { id: "perf-gb-translations", mondayBoardId: "9671510799", name: "ALL translations", label: "Translations" },
  ];
  const total = Math.max(60, Math.round(3000 * SCALE));
  await db.mondayGhostBoard.createMany({
    data: boards.map((b) => ({ ...b, itemCount: b.id === "perf-gb-preorder" ? total : 0, lastSyncedAt: minutesAgo(90) })),
  });

  const labelSets: Record<string, string[]> = {
    status: ORDER_STATUSES, status_18__1: BUSINESS_AREAS, dropdown__1: COLOUR_CODES, certifications__1: CERTIFICATES,
    sizes__1: [...new Set(SIZE_RUNS.flat())], dropdown_mktbzd1f: WASH_CARE_LABELS, status87__1: TARGET_GROUPS,
    dup__of_status__1: SHIPPING_TERMS, dropdown4__1: TRIMS, dropdown9__1: PRODUCT_GROUPS, status_1__1: SAMPLE_STATUSES,
    status_mkv2k1pa: ARTWORK_STATUSES, dropdown_brand__1: BRANDS, status_qc__1: QC_STATUSES,
  };
  await db.mondayGhostColumn.createMany({
    data: PRE_ORDER_COLUMNS.map((c, i) => ({
      id: `perf-gc-${pad(i, 2)}`,
      boardId: "perf-gb-preorder",
      mondayColumnId: c.id,
      title: c.title,
      type: c.type,
      settings: labelSets[c.id]
        ? c.type === "status"
          ? { labels: Object.fromEntries(labelSets[c.id].map((l, k) => [String(k), l])) }
          : { labels: labelSets[c.id].map((l, k) => ({ id: k + 1, name: l })) }
        : c.type === "board_relation"
          ? { boardIds: [Number(c.id === "customer__1" ? 3317892788 : 3363275451)] }
          : undefined,
      lastSyncedAt: minutesAgo(90),
    })),
  });
  const options = PRE_ORDER_COLUMNS.flatMap((c, i) =>
    (labelSets[c.id] ?? []).map((label, k) => ({
      id: `perf-go-${pad(i, 2)}-${pad(k, 2)}`,
      boardColumnId: `perf-gc-${pad(i, 2)}`,
      optionId: String(c.type === "status" ? k : k + 1),
      label,
      color: c.type === "status" ? `#${pad(k * 111111, 6).slice(0, 6)}` : null,
      lastSyncedAt: minutesAgo(90),
    })),
  );
  await db.mondayGhostDropdownOption.createMany({ data: options });

  const promotedCount = Math.round(total * 0.62);
  const promotedPool = styles.filter((s) => !s.deletedAt);
  const promoted = rngFor("ghost-promoted").sample(promotedPool, promotedCount);
  const specKeys = new Set(specs.map((p) => `${p.customer.id}::${p.ba.id}`));
  const ambiguousCustomer = customers.find((c) => c.name.startsWith("JYSK A/S"))!;
  const homeBa = bas.find((b) => b.mondayValue === "Home")!;
  const outletBa = bas.find((b) => b.mondayValue === "Outlet")!;
  const blankBa = bas.find((b) => b.mondayValue === "–")!;

  type GhostRow = Prisma.MondayGhostItemCreateManyInput;
  const rows: GhostRow[] = [];
  const toRow = (id: string, f: ItemFacts): GhostRow => ({
    id,
    boardId: "perf-gb-preorder",
    mondayItemId: f.mondayItemId,
    name: f.name,
    groupId: f.groupId,
    groupTitle: f.groupTitle,
    columnValues: ghostColumnValues(buildPreOrderItem(f)),
    lastSyncedAt: minutesAgo(90),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  });
  promoted.forEach((s, k) => rows.push(toRow(`perf-gi-p${pad(k, 5)}`, s.facts)));

  const buckets: Array<[string, number]> = [
    ["archived", 25], ["importable", 20], ["ambiguous", 8], ["unmatched", 12], ["blankBa", 12], ["unknownBa", 6], ["newCombo", 17],
  ];
  for (let k = 0; k < total - promotedCount; k++) {
    const r = rngFor(`ghost:${k}`);
    const bucket = buckets[r.weighted(buckets.map(([, w]) => w))][0];
    let customer: CustomerRow | null = r.pick(customers);
    let ba: BaRow | null = specs.find((p) => p.customer.id === customer!.id)?.ba ?? bas[0];
    let name = `IL${20000 + ((k * 6007) % 79990)}`;
    let groupId = "topics";
    let groupTitle = "📦 Pre Orders";
    if (bucket === "archived") [groupId, groupTitle] = r.chance(0.7) ? ["group_done", "✅ Done"] : ["group_cancelled", "Cancelled"];
    if (bucket === "ambiguous") {
      // No customer link; the name's leading token matches five JYSK entities.
      customer = null;
      ba = homeBa;
      name = `JYSK ${r.pick(["Malte", "Nora", "Bjørk", "Ellen"])} ${r.pick(["small", "large", "set"])} ${k}`;
    }
    if (bucket === "unmatched") customer = null;
    if (bucket === "blankBa") ba = r.chance(0.5) ? blankBa : null;
    if (bucket === "unknownBa") ba = { id: "", mondayValue: r.pick(["Outdoor Collection", "Seasonal", "PL Kids"]) };
    if (bucket === "newCombo") {
      ba = customer && !specKeys.has(`${customer.id}::${outletBa.id}`) ? outletBa : homeBa;
      if (customer && specKeys.has(`${customer.id}::${ba.id}`)) ba = outletBa;
    }
    if (bucket === "importable" && customer) {
      const own = specs.filter((p) => p.customer.id === customer!.id);
      ba = r.pick(own).ba;
    }
    const supplier = r.pick(suppliers);
    const createdAt = minutesAgo(r.int(60, 60 * 24 * 60));
    const mondayItemId = String(8_100_000_000 + k * 11);
    const facts = buildFacts(
      100_000 + k,
      r,
      customer ?? ambiguousCustomer,
      ba,
      supplier,
      name,
      r.chance(0.85) ? `C-PO${63000 + r.int(0, 400)}` : "",
      groupId,
      groupTitle,
      createdAt,
      addMinutes(createdAt, r.int(10, 6000)),
      new Set(),
      mondayItemId,
    );
    if (!customer) facts.customer = null;
    rows.push(toRow(`perf-gi-u${pad(k, 5)}`, facts));
  }
  await insertChunked("monday_ghost_items", rows, 200, (chunk) => db.mondayGhostItem.createMany({ data: chunk }));
  console.log(`  monday_ghost_columns: ${PRE_ORDER_COLUMNS.length}, monday_ghost_dropdown_options: ${options.length}`);
}

async function seedAppSettings(styles: StyleRow[]) {
  // Done-group re-admission cutoff a little below the newest PO, so the
  // /styles pre-scan has real work and re-admits a slice of the Done group.
  const maxPo = Math.max(...styles.map((s) => s.poSeq ?? 0));
  const settings: Array<[string, Prisma.InputJsonValue]> = [
    ["autoGenerateEnabled", true],
    ["doneGroupPoCutoff", maxPo - 600],
    ["supplierSendMinPo", 62300],
    ["styleSubfolderMinPo", 62800],
    ["automationMinPo", 62000],
    ["generationMinPo", 62000],
    ["poEanAutoRunEnabled", true],
    ["supplierBatchSendEnabled", false],
    ["mondayWriteBackEnabled", false],
    ["reviewNotificationEmails", "admin@perf.local, reviewer@perf.local"],
    ["supplierReviewCcEmails", "qa@perf.local"],
    ["coverPageInfoMd", "**Contrast A/S** · Questions about these files: production@contrast.example.com\n\nAll artwork must be printed at 100% scale."],
    // The admin's column view: standard columns plus the review/approval and
    // SharePoint rollups, so the batched rollup queries run as they would for
    // an admin who opted into them.
    ["stylesTableColumns", { visible: ["style", "po", "customer", "businessArea", "group", "generation", "status", "ean", "lastSynced", "supplier", "prodSpec", "sharepoint", "approved", "awaitingReview", "reviewer"] }],
  ];
  await db.appSetting.createMany({ data: settings.map(([key, value]) => ({ key, value })) });
  console.log(`  app_settings: ${settings.length}`);
  // Keep the shared mapping row in step with the code defaults.
  await db.mondayColumnConfig.upsert({
    where: { id: "global" },
    create: { id: "global", columnMapping: DEFAULT_COLUMN_MAPPING, requiredFields: [] },
    update: { columnMapping: DEFAULT_COLUMN_MAPPING },
  });
}

async function stampReferenceRows() {
  const both = [
    "languages", "countries", "wash_symbols", "certificates", "care_labels", "info_area_sizes", "qr_images",
    "translations", "customers", "business_areas", "suppliers", "supplier_contacts", "monday_ghost_boards",
    "monday_ghost_columns", "monday_ghost_dropdown_options", "monday_column_config", "style_output_field_values",
    "customer_business_area_combos",
  ];
  for (const t of both) await db.$executeRawUnsafe(`UPDATE "${t}" SET "createdAt" = $1, "updatedAt" = $1`, REF_AT);
  await db.$executeRawUnsafe(`UPDATE customer_business_area_combos SET "firstSeenAt" = $1, "lastSeenAt" = $2`, REF_AT, minutesAgo(60));
  await db.$executeRawUnsafe(`UPDATE prod_spec_suppliers SET "createdAt" = $1`, REF_AT);
  await db.$executeRawUnsafe(`UPDATE app_settings SET "updatedAt" = $1`, REF_AT);
  await db.$executeRawUnsafe(`UPDATE users SET "updatedAt" = "createdAt" WHERE id <> $1`, ADMIN_ID);
}

async function report() {
  const tables = [...OWNED_TABLES, "users", "doc_types", "trim_concept_rows", "monday_column_config"];
  const rows = (
    await Promise.all(
      tables.map(async (t) => {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`);
        return { t, n: Number(n) };
      }),
    )
  )
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const [raw] = await db.$queryRawUnsafe<Array<{ avg_text: number; avg_stored: number; total_mb: number }>>(
    `SELECT avg(octet_length("rawData"::text))::float AS avg_text,
            avg(pg_column_size("rawData"))::float AS avg_stored,
            (pg_total_relation_size('styles') / 1048576.0)::float AS total_mb
       FROM styles`,
  );
  console.log("\nRow counts:");
  for (const r of rows) console.log(`  ${r.t.padEnd(34)} ${r.n}`);
  console.log(
    `\nStyle.rawData: avg ${(raw.avg_text / 1024).toFixed(1)} KB as JSON text, ` +
      `${(raw.avg_stored / 1024).toFixed(1)} KB stored (TOAST-compressed); styles table total ${raw.total_mb.toFixed(1)} MB`,
  );
}

async function main() {
  assertLocalDatabase();
  const t0 = Date.now();
  console.log(`Seeding ${process.env.DATABASE_URL!.replace(/:[^:@/]+@/, ":***@")} — ${STYLE_COUNT} styles, seed ${SEED}, now ${NOW.toISOString()}`);
  await truncate();
  await seedUsers();
  await seedCatalogues();
  const { customers, bas, suppliers } = await seedCustomersAndSuppliers();
  const layouts = await seedLayouts(customers, bas);
  const specs = await seedProdSpecs(customers, bas, suppliers, layouts);
  const variantByKey = new Map<string, VariantMeta>();
  for (const v of TEMPLATE_VARIANTS) {
    variantByKey.set(v.key, { key: v.key, docType: v.docType, name: v.name, widthMm: v.defaultWidthMm, heightMm: v.defaultHeightMm, multiDoc: false, layoutVersion: null });
  }
  for (const l of layouts) variantByKey.set(l.key, l);

  const styles = planStyles(customers, bas, suppliers, specs);
  // Jobs decide the stored Style.status, so plan them before writing styles.
  const jobResult = await seedJobs(styles, variantByKey);
  await insertStyles(styles);
  await insertJobs(jobResult);
  await seedStyleOverrides(styles);
  await seedCombos(styles, specs);
  await seedGhosts(styles, customers, bas, suppliers, specs);
  await seedAppSettings(styles);
  await stampReferenceRows();

  // Fresh planner statistics, as autovacuum would have them in production —
  // right after a bulk load the planner otherwise guesses row counts.
  await db.$executeRawUnsafe("VACUUM (ANALYZE)");
  await report();
  console.log(`\nReview queue: ${jobResult.queueStyleIds.length} styles awaiting review (first: ${jobResult.queueStyleIds[0]})`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });

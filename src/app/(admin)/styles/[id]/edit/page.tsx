import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  parseCustomerConfig,
  type ColumnMapping,
} from "@/lib/customers/config";
import type { MondayItem } from "@/lib/monday/client";
import { resolveMappedField } from "@/lib/styles/resolved-fields";
import { ManualStyleForm, type ManualFormState } from "../../new/manual-style-form";
import { SavedDataPanel } from "./saved-data-panel";

type WashSymbolLite = { code: string; name: string; mondayValue: string | null };

export const dynamic = "force-dynamic";

export default async function EditStylePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [style, customers, suppliers, businessAreas, washSymbols, qrImages, logoImages, prodSpecs] = await Promise.all([
    db.style.findUnique({ where: { id }, include: { customer: true } }),
    db.customer.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true },
    }),
    db.supplier.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, country: true },
    }),
    db.businessArea.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, mondayValue: true, name: true },
    }),
    db.washSymbol.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, svg: true, mondayValue: true },
    }),
    db.qrImage.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, image: true },
    }),
    db.logoImage.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, image: true },
    }),
    db.prodSpec.findMany({
      where: { active: true },
      select: { id: true, name: true, customerId: true, businessAreaId: true, outputs: true },
    }),
  ]);

  if (!style) notFound();

  const initial = formStateFromStyle(style, customers, washSymbols);

  return (
    <div className="px-8 py-8">
      <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">
        ← Back to style
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit · {style.name}</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Saving regenerates all PDFs and lands on the review page. Toggle on the review screen if you
        want to approve afterwards.
      </p>

      <ManualStyleForm
        mode="edit"
        styleId={style.id}
        customers={customers}
        suppliers={suppliers}
        businessAreas={businessAreas}
        washSymbols={washSymbols}
        qrImages={qrImages}
        logoImages={logoImages}
        prodSpecs={prodSpecs.map((p) => ({
          id: p.id,
          name: p.name,
          customerId: p.customerId,
          businessAreaId: p.businessAreaId,
          outputsCount: Array.isArray(p.outputs) ? (p.outputs as unknown[]).length : 0,
        }))}
        initial={initial}
      />

      <SavedDataPanel
        style={{
          id: style.id,
          name: style.name,
          mondayItemId: style.mondayItemId,
          mondayBoardId: style.mondayBoardId,
          groupId: style.groupId,
          groupTitle: style.groupTitle,
          poNumber: style.poNumber,
          businessArea: style.businessArea,
          completionPct: style.completionPct,
          status: style.status,
          rawData: style.rawData,
        }}
        customer={{
          id: style.customer.id,
          name: style.customer.name,
          slug: style.customer.slug,
          config: style.customer.config,
        }}
      />
    </div>
  );
}

// Prisma's generic find typings don't play nicely with deep includes in
// older versions; we declare the local shape we need from the include
// inline. Mirrors what the page query above actually selects.
type StyleWithCustomer = NonNullable<
  Awaited<ReturnType<typeof db.style.findUnique>>
> & {
  customer: { id: string; config: unknown };
};

function formStateFromStyle(
  style: StyleWithCustomer,
  customers: Array<{ id: string }>,
  washSymbols: WashSymbolLite[],
): ManualFormState {
  // The rawData is a synthetic MondayItem for manual styles, or the real
  // Monday item shape for webhook-ingested ones (with Pre-Order "po.*"
  // columns merged in by the enrichment step). Use the customer's
  // merged column mapping (DEFAULT_COLUMN_MAPPING ⨯ per-customer
  // override) to find each field on either shape; fall back to the
  // MANUAL_COLUMN_IDS for legacy / pure-manual styles.
  const item = style.rawData as unknown as MondayItem | null;
  const cfg = parseCustomerConfig(style.customer.config);
  const mapping = cfg.columnMapping;

  // Read by mapped id first; if empty, try the manual fallback so
  // pure-manual entries still populate. Shared with the Details tab so
  // both views resolve fields identically.
  const readField = (field: keyof ColumnMapping) =>
    resolveMappedField(item, mapping, field);

  // Wash care: Monday emits free-text phrases ("Wash at or below 40℃,
  // Do Not Bleach, ..."). Try to resolve each phrase to a WashSymbol
  // code via case-insensitive match on mondayValue first, then name.
  // Phrases that don't match are kept verbatim — the form treats them
  // as unknown codes and the operator can either add a WashSymbol row
  // (with the right mondayValue) or pick equivalents manually.
  const washRaw = readField("washCare");
  const washSymbolCodes = washRaw
    ? washRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((phrase) => resolveWashCode(phrase, washSymbols))
    : [];

  return {
    customerId: customers.some((c) => c.id === style.customerId) ? style.customerId : customers[0]?.id ?? "",
    supplierId: style.supplierId ?? "",
    businessAreaId: style.businessAreaId ?? "",
    styleName: style.name,
    styleNumber: readField("styleNumber"),
    businessArea: style.businessArea ?? "",
    composition: readField("composition"),
    productNameTranslations: readField("productNameTranslations"),
    washSymbolCodes,
    sizes: readField("sizes"),
    ean13: readField("ean13"),
    klNumber: readField("klNumber"),
    supplierNumber: readField("supplierNumber"),
    lot: readField("lot"),
    cartonQty: readField("cartonQty"),
    cartonEan: readField("cartonEan"),
    colourName: readField("colourName"),
    colourCode: readField("colourCode"),
    price: readField("price"),
    supplierEmail: readField("supplierEmail"),
    countryOfOrigin: readField("countryOfOrigin"),
    qrImageId: style.qrImageId ?? "",
    logoImageId: style.logoImageId ?? "",
  };
}

// Normalise a phrase so trivial drift (trailing punctuation, double
// spaces, casing) doesn't break the WashSymbol lookup. Same string
// applied to both sides of the compare. Examples:
//   "Wash at or below 30℃."    → "wash at or below 30℃"
//   "Tumble Dry- Low  "        → "tumble dry low"
//   "Iron- Medium Temperature" → "iron medium temperature"
function normalisePhrase(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,;:!]+$/u, "") // strip trailing punctuation
    .replace(/[-]/g, " ") // dashes → space ("Iron-Low" === "Iron Low")
    .replace(/\s+/g, " "); // collapse whitespace
}

// Phrase → WashSymbol.code lookup. Tries normalised mondayValue first
// (explicit "this is what Monday sends"), then name. Unmatched phrases
// pass through verbatim — they'll render as "missing" tiles in the
// picker so the operator notices.
function resolveWashCode(phrase: string, washSymbols: WashSymbolLite[]): string {
  const needle = normalisePhrase(phrase);
  if (!needle) return phrase;
  const byMonday = washSymbols.find(
    (s) => s.mondayValue && normalisePhrase(s.mondayValue) === needle,
  );
  if (byMonday) return byMonday.code;
  const byName = washSymbols.find((s) => normalisePhrase(s.name) === needle);
  if (byName) return byName.code;
  return phrase;
}

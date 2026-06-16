import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import {
  MANUAL_COLUMN_IDS,
  parseCustomerConfig,
  type ColumnMapping,
  type CustomerConfig,
} from "@/lib/customers/config";
import { projectSiblingStyle } from "@/lib/output-layouts/tokens";
import { MAX_SIBLING_SLOTS } from "@/lib/output-layouts/token-meta";
import {
  parseProdSpecColumnMapping,
  parseProdSpecLanguages,
  parseProdSpecOutputs,
  type ProdSpecOutput,
} from "@/lib/prod-spec/config";
import { mapMondayItemToStyleData } from "@/lib/pdf/mapper";
import { loadWashcareSymbols, rejoinWashTokens } from "@/lib/pdf/washcare-symbols";
import type { MondayItem } from "@/lib/monday/client";
import type { StyleData } from "@/lib/pdf/types";
import { effectiveStyleItem } from "./resolved-fields";
import { outputReadinessForStyle, type OutputReadiness } from "./output-readiness";

// =====================================================
// Shared render context — the ONE place StyleData is assembled from a
// style record + its ProdSpec. The job runner and the preview endpoints
// both consume this, so a preview can never drift from what the real
// render would produce (same fallback injection, same mapping priority,
// same per-ProdSpec context).
//
// Extracted from the runner's processJob() — behaviour-identical, plus
// one deliberate improvement: wash-care tokens are re-joined/normalised
// against the symbol catalogue (Monday labels containing ", " shear into
// fragments under the mapper's comma split — see rejoinWashTokens).
// =====================================================

// The style fields the assembly needs. Matches what the runner's job
// include and the preview loader both fetch.
export type RenderableStyle = {
  // The Style.id — needed to exclude self from the same-PO sibling fetch
  // (Custom Carton Marking) and to tag each sibling for the carton dialog.
  id: string;
  rawData: unknown;
  poNumber: string | null;
  cartonEan: string | null;
  mondayBoardId: string;
  supplier: { country: string | null } | null;
  eans: ReadonlyArray<{ size: string; ean13: string | null; variantLabel?: string | null }>;
  customer: { name: string; config: unknown };
  qrImage: { image: string } | null;
};

export type RenderableProdSpec = {
  logoSvg: string | null;
  careInstructionsByLang: unknown;
  outputLanguages: unknown;
  columnMapping: unknown;
  outputs: unknown;
} | null;

// Safely coerce ProdSpec.careInstructionsByLang JSON into a flat
// { langCode: string } map. Invalid shapes return {} so the template
// can render with no care text rather than crash.
export function parseCareInstructions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v;
  }
  return out;
}

// Build the StyleData a template renders from. `config` is the PARSED
// customer config — callers parse it themselves so they keep their own
// error semantics (the runner tags a parse failure CONFIG_INVALID before
// mapping ever starts).
export async function buildStyleData(
  style: RenderableStyle,
  prodSpec: RenderableProdSpec,
  config: CustomerConfig,
  // Pre-fetch the same-PO sibling POOL (Custom Carton Marking). OFF by
  // default: siblings are only ever used by a MANUAL multi-style carton
  // print, so standard generation (the runner) skips the extra query +
  // per-sibling mapping. The preview/dialog loaders (loadStyleRenderContext)
  // opt in so the carton dialog + multi-style preview have candidates.
  opts: { loadSiblings?: boolean } = {},
): Promise<StyleData> {
  // Inject the canonical Style.poNumber as the manual.* fallback so the PO
  // renders on labels even when the mapped PO column isn't the one this
  // style's board populated — and the PO-PDF-resolved EANs / carton EAN so
  // barcodes render from the scrape. See effectiveStyleItem.
  const item = effectiveStyleItem({
    rawData: style.rawData,
    poNumber: style.poNumber,
    supplier: style.supplier,
    eans: style.eans,
    cartonEan: style.cartonEan,
  }) as MondayItem;

  // Resolution order for column mapping:
  //   1. ProdSpec.columnMapping  (when non-empty — operator override)
  //   2. Customer.config.columnMapping (when non-empty — per-tenant default)
  //   3. MANUAL_COLUMN_IDS  (only for `mondayBoardId === "manual"` styles)
  const prodSpecMapping =
    prodSpec && Object.keys((prodSpec.columnMapping as object) ?? {}).length > 0
      ? parseProdSpecColumnMapping(prodSpec.columnMapping)
      : null;
  const customerMapping =
    Object.keys(config.columnMapping).length > 0 ? config.columnMapping : null;
  const isManualStyle = style.mondayBoardId === "manual";
  const effectiveMapping =
    prodSpecMapping ??
    customerMapping ??
    (isManualStyle ? { ...MANUAL_COLUMN_IDS } : config.columnMapping);

  const styleData = mapMondayItemToStyleData(
    item,
    {
      customerName: style.customer.name,
      customerLogoUrl: config.logoUrl,
      barcodeFont: config.barcodeFont,
      prodSpecLogoSvg: prodSpec?.logoSvg ?? null,
      careInstructionsByLang: parseCareInstructions(prodSpec?.careInstructionsByLang),
      outputLanguages: parseProdSpecLanguages(prodSpec?.outputLanguages),
      qrImageUrl: style.qrImage?.image ?? null,
    },
    effectiveMapping,
  );

  // Raw EAN rows (one per size × colour combo) for the Output Builder's
  // repeat-per-EAN — `sizes` is deduped by size via the ean-map string,
  // which silently drops second colourways. Colour parsed from the PO
  // variant label ("PI-35/38 Pink, 35/38" → "Pink").
  styleData.eanVariants = style.eans
    .filter((e) => (e.ean13 ?? "").trim())
    .map((e) => ({
      size: e.size,
      ean13: e.ean13!,
      colour: colourFromVariantLabel(e.variantLabel ?? null, e.size),
    }));

  // Wash-care token repair: Monday dropdown labels can contain ", " and the
  // mapper's comma split shears them into unresolvable fragments. Re-join
  // against the catalogue so e.g. "Dry Clean, Any Solvent" stays one symbol.
  if (styleData.washSymbols.length > 1) {
    const symbolMap = await loadWashcareSymbols();
    styleData.washSymbols = rejoinWashTokens(styleData.washSymbols, symbolMap);
  }

  // Custom Carton Marking: pre-fetch the same-PO siblings POOL so the carton
  // dialog can offer candidates and a multi-style preview/print resolves
  // {{style2}}+ SYNC. Opt-in (loadSiblings) + guarded by poNumber. The flag
  // style.multipleStyles — set later by withSelectedSiblings on a one-off
  // print — is what actually gates {{style2}}+; the pool alone never leaks
  // into standard generation.
  if (opts.loadSiblings && style.poNumber) {
    styleData.siblings = await loadSiblingStyles(
      style.id,
      style.poNumber,
      effectiveMapping,
      style.customer.name,
    );
  }

  return styleData;
}

// How many same-PO siblings to load into the pool. A layout can reference
// at most MAX_SIBLING_SLOTS-1 siblings; load a few extra so the carton
// dialog's one-off picker can offer more candidates than any single layout
// uses, without an unbounded query on a large PO.
const SIBLING_POOL_CAP = Math.max(MAX_SIBLING_SLOTS - 1, 3) + 16;

// Load the OTHER styles on the same PO and project each to a SiblingStyle
// (carton-relevant fields only). Each sibling is mapped with the CURRENT
// style's effective column mapping + customer name: same-PO styles are
// virtually always the same customer/board, so this reuses the already
// resolved mapping instead of re-deriving each sibling's ProdSpec — and it
// maps siblings WITHOUT fetching their own siblings (no recursion). Ordered
// by creation so the slot assignment is stable across renders.
async function loadSiblingStyles(
  thisId: string,
  poNumber: string,
  mapping: ColumnMapping,
  customerName: string,
): Promise<StyleData["siblings"]> {
  const rows = await db.style.findMany({
    where: { poNumber, id: { not: thisId }, archivedAt: null, deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: SIBLING_POOL_CAP,
    select: {
      id: true,
      rawData: true,
      poNumber: true,
      cartonEan: true,
      supplier: { select: { country: true } },
      eans: {
        orderBy: { position: "asc" },
        select: { size: true, ean13: true, variantLabel: true },
      },
    },
  });
  return rows.map((row) => {
    const item = effectiveStyleItem({
      rawData: row.rawData,
      poNumber: row.poNumber,
      supplier: row.supplier,
      eans: row.eans,
      cartonEan: row.cartonEan,
    }) as MondayItem;
    const sd = mapMondayItemToStyleData(item, customerName, mapping);
    return projectSiblingStyle(sd, row.id);
  });
}

// =====================================================
// Preview-side loader — everything an output-preview endpoint needs for a
// style: the StyleData, the parsed outputs (dims + pins), and per-output
// readiness. The runner does NOT use this loader (it loads via its Job
// include) — it shares buildStyleData above, which is where drift matters.
// =====================================================

export type StyleRenderContext = {
  styleId: string;
  styleData: StyleData;
  prodSpec: { id: string; name: string } | null;
  outputs: ProdSpecOutput[];
  readiness: OutputReadiness[];
};

export async function loadStyleRenderContext(styleId: string): Promise<StyleRenderContext | null> {
  // Resolve Output Builder layout keys in the readiness walk below.
  await ensureLayoutVariantsLoaded();

  const style = await db.style.findUnique({
    where: { id: styleId },
    include: {
      customer: true,
      qrImage: true,
      supplier: { select: { country: true } },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, variantLabel: true } },
    },
  });
  if (!style) return null;

  const prodSpec = style.prodSpecId
    ? await db.prodSpec.findUnique({ where: { id: style.prodSpecId } })
    : null;

  const config = parseCustomerConfig(style.customer.config);
  const styleData = await buildStyleData(
    {
      id: style.id,
      rawData: style.rawData,
      poNumber: style.poNumber,
      cartonEan: style.cartonEan,
      mondayBoardId: style.mondayBoardId,
      supplier: style.supplier,
      eans: style.eans,
      customer: { name: style.customer.name, config: style.customer.config },
      qrImage: style.qrImage ? { image: style.qrImage.image } : null,
    },
    prodSpec,
    config,
    // The preview/dialog loader — load the same-PO sibling pool so the carton
    // dialog can offer candidates and a multi-style preview resolves.
    { loadSiblings: true },
  );

  const outputs = prodSpec
    ? parseProdSpecOutputs(prodSpec.outputs).filter((o) => o.enabled !== false)
    : [];

  const readiness = prodSpec
    ? outputReadinessForStyle({
        rawData: style.rawData,
        poNumber: style.poNumber,
        supplier: style.supplier,
        eans: style.eans,
        cartonEan: style.cartonEan,
        customer: { config: style.customer.config },
        prodSpec: { outputs: prodSpec.outputs, columnMapping: prodSpec.columnMapping },
      })
    : [];

  return {
    styleId,
    styleData,
    prodSpec: prodSpec ? { id: prodSpec.id, name: prodSpec.name } : null,
    outputs,
    readiness,
  };
}

// Parse the colour out of a PO variant label. Observed shape:
//   "PI-35/38 Pink, 35/38"            → "Pink"
//   "A-XL Black w silver lurex, XL"   → "Black w silver lurex"
//   "A-S/M Colour A, S/M"             → "Colour A"
// (<code>-<size> <colour>, <size>) — strip the trailing ", <size>" and the
// leading "<code>-<size> ". Anything unparseable returns the label trimmed
// (better a verbose colour than a lost one); null/empty → null.
export function colourFromVariantLabel(label: string | null, size: string): string | null {
  if (!label || !label.trim()) return null;
  let s = label.trim();
  const tail = `, ${size}`;
  if (s.endsWith(tail)) s = s.slice(0, -tail.length).trim();
  const marker = `-${size} `;
  const at = s.indexOf(marker);
  if (at > -1) s = s.slice(at + marker.length).trim();
  return s || null;
}

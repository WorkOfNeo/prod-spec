import { db } from "@/lib/db";
import { parseCustomerConfig } from "@/lib/customers/config";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { conceptHasArtwork } from "./concepts";
import { classifyLayoutName, classifyTrimLabel, normalizeTrimLabel, splitTrimsCell } from "./classify";
import { loadTrimSettings } from "@/lib/outputs/required-packaging";

// =====================================================
// The fleet-wide picture behind /settings/trims: every distinct Monday Trims
// value in the book, what each currently resolves to, and where the buyer's
// list and our declared outputs disagree.
//
// WHY RAW SQL. The obvious implementation — read every style and run the same
// resolver the render uses — moves ~6,000 Monday item blobs through Node and
// takes about 90 seconds. Plucking one column out of the JSON in Postgres does
// the same job in under two. The column id is per-customer (ColumnMapping.trims),
// so customers are grouped by the id they use, which is one or two queries in
// practice rather than one per customer.
//
// KNOWN APPROXIMATION, and the reason it is acceptable: this path does NOT
// apply per-style output ignores or doc-type keyword rules, so a style whose
// banderole a reviewer switched off still counts its banderole as declared.
// That is fine for a VOCABULARY screen — the question here is "what words exist
// and what do they mean", and it is answered over thousands of styles at once.
// The moment the question becomes "what will THIS cover print", the answer must
// come from buildRequiredPackagingForStyle, which applies every filter. The
// before/after preview does exactly that; nothing here feeds a rendered page.
// =====================================================

export type CensusLabel = {
  // The most common spelling, which is what a person will recognise.
  label: string;
  normalized: string;
  styles: number;
  concepts: string[];
  // "override" — a stored decision; "rule" — matched a keyword rule;
  // "none" — unknown vocabulary, printed as manually supplied until mapped.
  source: "override" | "rule" | "none";
  // Several rules matched. The first won; a human should confirm it.
  ambiguous: boolean;
};

export type CensusLayout = {
  variantKey: string;
  name: string;
  docType: string;
  status: string;
  concept: string | null;
  source: "override" | "rule" | "none";
};

export type CensusCoverage = {
  // Styles wanting an ARTWORK trim that no declared output produces.
  stylesWithArtworkGap: number;
  stylesConsidered: number;
  // concept -> styles where Monday asks for it and nothing declared answers.
  gapByConcept: Array<{ concept: string; styles: number; artwork: boolean }>;
  // concept -> styles that declare it while Monday never mentions it. The
  // reverse direction matters just as much: it is how we learn the Trims column
  // itself is incomplete.
  extraByConcept: Array<{ concept: string; styles: number }>;
};

export type TrimCensus = {
  labels: CensusLabel[];
  layouts: CensusLayout[];
  coverage: CensusCoverage;
  totals: { styles: number; stylesWithTrims: number; distinctLabels: number };
};

// styleId -> the raw Trims cell, plucked in Postgres.
async function loadTrimCells(): Promise<Map<string, { customerId: string; prodSpecId: string | null; raw: string }>> {
  const customers = await db.customer.findMany({ select: { id: true, config: true } });
  // Group customers by the column id they map Trims to — normally everyone
  // shares the default, so this is one query.
  const byColumn = new Map<string, string[]>();
  for (const c of customers) {
    const col = parseCustomerConfig(c.config).columnMapping.trims;
    if (!col) continue;
    const list = byColumn.get(col);
    if (list) list.push(c.id);
    else byColumn.set(col, [c.id]);
  }

  const out = new Map<string, { customerId: string; prodSpecId: string | null; raw: string }>();
  for (const [column, customerIds] of byColumn) {
    if (customerIds.length === 0) continue;
    const rows = await db.$queryRawUnsafe<
      Array<{ id: string; customerId: string; prodSpecId: string | null; trims: string | null }>
    >(
      `SELECT s.id, s."customerId", s."prodSpecId",
              (SELECT cv->>'text'
                 FROM jsonb_array_elements(s."rawData"->'column_values') cv
                WHERE cv->>'id' = $1
                LIMIT 1) AS trims
         FROM styles s
        WHERE s."deletedAt" IS NULL
          AND s."customerId" = ANY($2::text[])`,
      column,
      customerIds,
    );
    for (const r of rows) {
      out.set(r.id, { customerId: r.customerId, prodSpecId: r.prodSpecId, raw: r.trims ?? "" });
    }
  }
  return out;
}

export async function buildTrimCensus(): Promise<TrimCensus> {
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  const { getVariant } = await import("@/lib/pdf/template-registry");
  await ensureLayoutVariantsLoaded();

  const settings = await loadTrimSettings();
  const { rules, overrides, layoutConcepts } = settings;

  // ---- Layouts. Both what they classify as and whether a human pinned it.
  const layoutRows = await db.outputLayout.findMany({
    select: { id: true, name: true, docType: true, status: true },
    orderBy: [{ name: "asc" }],
  });
  const layouts: CensusLayout[] = layoutRows.map((l) => {
    const variantKey = `layout:${l.id}`;
    const pinned = Object.prototype.hasOwnProperty.call(layoutConcepts, variantKey);
    const concept = pinned ? layoutConcepts[variantKey] || null : classifyLayoutName(l.name, rules);
    return {
      variantKey,
      name: l.name,
      docType: l.docType,
      status: l.status,
      concept,
      source: pinned ? "override" : concept ? "rule" : "none",
    };
  });
  const conceptByVariantKey = new Map(layouts.map((l) => [l.variantKey, l.concept]));

  // ---- Labels.
  const cells = await loadTrimCells();
  const spellings = new Map<string, Map<string, number>>();
  const labelStyles = new Map<string, number>();
  let stylesWithTrims = 0;
  const trimConceptsByStyle = new Map<string, Set<string>>();

  for (const [styleId, cell] of cells) {
    const labels = splitTrimsCell(cell.raw);
    if (labels.length === 0) continue;
    stylesWithTrims += 1;
    const concepts = new Set<string>();
    for (const label of labels) {
      const key = normalizeTrimLabel(label);
      labelStyles.set(key, (labelStyles.get(key) ?? 0) + 1);
      const bySpelling = spellings.get(key) ?? new Map<string, number>();
      bySpelling.set(label, (bySpelling.get(label) ?? 0) + 1);
      spellings.set(key, bySpelling);
      const resolved = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : classifyTrimLabel(label, rules).concepts;
      for (const c of resolved) concepts.add(c);
    }
    trimConceptsByStyle.set(styleId, concepts);
  }

  const labels: CensusLabel[] = [...labelStyles.entries()]
    .map(([key, styles]) => {
      // Show the spelling people actually see most often.
      const bySpelling = spellings.get(key) ?? new Map();
      const label = [...bySpelling.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key;
      const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
      const classified = classifyTrimLabel(label, rules);
      const concepts = overridden ? overrides[key] : classified.concepts;
      return {
        label,
        normalized: key,
        styles,
        concepts,
        source: overridden ? ("override" as const) : concepts.length > 0 ? ("rule" as const) : ("none" as const),
        ambiguous: !overridden && classified.ambiguous,
      };
    })
    .sort((a, b) => b.styles - a.styles);

  // ---- Coverage. Declared outputs are resolved ONCE per ProdSpec (a spec is a
  // Customer x Business Area, so a few dozen cover the whole book) and reused
  // for every style pointing at it.
  const specs = await db.prodSpec.findMany({ select: { id: true, outputs: true } });
  const conceptsBySpec = new Map<string, Set<string>>();
  for (const spec of specs) {
    const set = new Set<string>();
    for (const o of parseProdSpecOutputs(spec.outputs ?? []).filter((x) => x.enabled !== false)) {
      const base = o.variantKey.split("#")[0];
      let concept = conceptByVariantKey.get(base) ?? null;
      if (concept === undefined || concept === null) {
        if (Object.prototype.hasOwnProperty.call(layoutConcepts, base)) {
          concept = layoutConcepts[base] || null;
        } else {
          const variant = getVariant(o.variantKey);
          concept = variant?.name ? classifyLayoutName(variant.name, rules) : null;
        }
      }
      if (concept) set.add(concept);
    }
    conceptsBySpec.set(spec.id, set);
  }

  const gap = new Map<string, number>();
  const extra = new Map<string, number>();
  let stylesWithArtworkGap = 0;
  let stylesConsidered = 0;

  for (const [styleId, cell] of cells) {
    const wanted = trimConceptsByStyle.get(styleId);
    if (!wanted || wanted.size === 0) continue;
    stylesConsidered += 1;
    const declared = (cell.prodSpecId && conceptsBySpec.get(cell.prodSpecId)) || new Set<string>();
    let gapped = false;
    for (const c of wanted) {
      if (declared.has(c)) continue;
      gap.set(c, (gap.get(c) ?? 0) + 1);
      if (conceptHasArtwork(c)) gapped = true;
    }
    for (const c of declared) {
      if (!wanted.has(c)) extra.set(c, (extra.get(c) ?? 0) + 1);
    }
    if (gapped) stylesWithArtworkGap += 1;
  }

  return {
    labels,
    layouts,
    coverage: {
      stylesWithArtworkGap,
      stylesConsidered,
      gapByConcept: [...gap.entries()]
        .map(([concept, styles]) => ({ concept, styles, artwork: conceptHasArtwork(concept) }))
        .sort((a, b) => b.styles - a.styles),
      extraByConcept: [...extra.entries()]
        .map(([concept, styles]) => ({ concept, styles }))
        .sort((a, b) => b.styles - a.styles),
    },
    totals: { styles: cells.size, stylesWithTrims, distinctLabels: labels.length },
  };
}

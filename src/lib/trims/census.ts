import { db } from "@/lib/db";
import { parseCustomerConfig } from "@/lib/customers/config";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { conceptHasArtwork } from "./concepts";
import { classifyLayoutName, classifyTrimLabel, normalizeTrimLabel, splitTrimsCell } from "./classify";
import { loadTrimSettings } from "@/lib/outputs/required-packaging";
import { getGenerationMinPo } from "@/lib/settings/app-settings";
import { isBelowGenerationCutoff } from "@/lib/queue/generation-cutoff";

// =====================================================
// The picture behind /settings/trims: every distinct Monday Trims value that
// still matters, what each currently resolves to, and where the buyer's list
// and our declared outputs disagree.
//
// WHY RAW SQL. The obvious implementation — read every style and run the same
// resolver the render uses — moves ~6,000 Monday item blobs through Node and
// takes about 90 seconds. Plucking one column out of the JSON in Postgres does
// the same job in under two. The column id is per-customer (ColumnMapping.trims),
// so customers are grouped by the id they use, which is one or two queries in
// practice rather than one per customer.
//
// SCOPED TO THE GENERATION CUTOFF. Originally this read every style in the
// book, which meant vocabulary from long-dead orders sat in the queue, got
// mapped by a person, and then shaped the concept rules for orders nobody will
// ever print. The vocabulary only matters for what will actually be PRINTED, so
// the scope is the GENERATION cutoff (generationMinPo — read through
// getGenerationMinPo, never re-derived here), not the scrape cutoff (which is
// about how far back we re-pull data) and not the supplier-send cutoff (which
// is about what leaves the building). Measured live, that takes the vocabulary
// from 173 distinct values to 92: nearly half the queue was archaeology.
//
// THE NULL poSeq RULE, and why it is not the sweep's rule verbatim. A style
// whose PO number did not PARSE onto the numeric timeline is IN scope — that is
// the generation sweep's own rule (isBelowGenerationCutoff), and an output that
// is ready should still generate. But a style with NO PO number at all is
// excluded, which mirrors the sweep's second gate (HAS_PO_NUMBER_WHERE): those
// are placeholders that will never be delivered, and their vocabulary should
// not be put in front of a person to map. Both halves are counted separately in
// `scope` so the split is visible rather than assumed.
//
// WHY THE PARTITION HAPPENS IN NODE, NOT IN THE WHERE CLAUSE. Pushing the
// cutoff into SQL would prune the JSON pluck and be marginally faster, but it
// would also make the BEFORE count unknowable without a second full pluck. One
// query that returns poSeq/poNumber alongside the cell answers both halves —
// measured at 297ms against 325ms for the old unscoped query, i.e. the extra
// two columns are free next to the JSON extraction. Keep it that way: if this
// ever becomes a per-style loop the whole screen regresses to ~90 seconds.
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

// What the PO scoping did, in numbers, so the screen can say plainly how much
// vocabulary it stopped asking about instead of silently showing a shorter list.
export type CensusScope = {
  // The generation cutoff in force. null = none configured (nothing is parked).
  cutoff: number | null;
  stylesInScope: number;
  // Excluded because the order predates the generation cutoff.
  stylesBelowCutoff: number;
  // Excluded because there is no PO number at all — a placeholder, not an order.
  stylesWithoutPo: number;
  // ADMITTED by the NULL rule: a PO number that is present but unparseable.
  stylesWithUnparseablePo: number;
  // Distinct labels across every style in the book — the "before".
  distinctLabelsBefore: number;
  // Distinct labels once scoped — the "after", and what the queue now holds.
  distinctLabelsAfter: number;
  // before - after: vocabulary that lives only on orders we will never print.
  distinctLabelsDropped: number;
};

export type TrimCensus = {
  labels: CensusLabel[];
  layouts: CensusLayout[];
  coverage: CensusCoverage;
  scope: CensusScope;
  totals: { styles: number; stylesWithTrims: number; distinctLabels: number };
};

type TrimCell = {
  customerId: string;
  prodSpecId: string | null;
  raw: string;
  poSeq: number | null;
  hasPoNumber: boolean;
};

// styleId -> the raw Trims cell plus the two fields the PO scoping needs, all
// plucked in Postgres. Every style is returned; the caller partitions.
async function loadTrimCells(): Promise<Map<string, TrimCell>> {
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

  const out = new Map<string, TrimCell>();
  for (const [column, customerIds] of byColumn) {
    if (customerIds.length === 0) continue;
    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        customerId: string;
        prodSpecId: string | null;
        poSeq: number | null;
        poNumber: string | null;
        trims: string | null;
      }>
    >(
      `SELECT s.id, s."customerId", s."prodSpecId", s."poSeq", s."poNumber",
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
      out.set(r.id, {
        customerId: r.customerId,
        prodSpecId: r.prodSpecId,
        raw: r.trims ?? "",
        poSeq: r.poSeq === null || r.poSeq === undefined ? null : Number(r.poSeq),
        hasPoNumber: typeof r.poNumber === "string" && r.poNumber.trim() !== "",
      });
    }
  }
  return out;
}

// The generation scope, as one predicate so every caller in this module reads
// the same rule, and exported so it can be unit-tested without a database.
// See the NULL poSeq note in the header: an unparseable PO is admitted, an
// absent one is not.
export function isStyleInGenerationScope(
  style: { poSeq: number | null; hasPoNumber: boolean },
  cutoff: number | null,
): boolean {
  if (!style.hasPoNumber) return false;
  return !isBelowGenerationCutoff(style.poSeq, cutoff);
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

  // ---- Labels, scoped to the generation cutoff.
  const cutoff = await getGenerationMinPo();
  const allCells = await loadTrimCells();
  const cells = new Map<string, TrimCell>();
  const labelsBefore = new Set<string>();
  const scope: CensusScope = {
    cutoff,
    stylesInScope: 0,
    stylesBelowCutoff: 0,
    stylesWithoutPo: 0,
    stylesWithUnparseablePo: 0,
    distinctLabelsBefore: 0,
    distinctLabelsAfter: 0,
    distinctLabelsDropped: 0,
  };

  for (const [styleId, cell] of allCells) {
    // The "before" vocabulary is counted from every style, in scope or not —
    // it is the only way to say what the scoping actually removed.
    for (const label of splitTrimsCell(cell.raw)) labelsBefore.add(normalizeTrimLabel(label));
    // The gate is the predicate; the reason is attributed only after it has
    // decided, so the counts can never describe a different rule than the one
    // that actually ran.
    if (!isStyleInGenerationScope(cell, cutoff)) {
      if (!cell.hasPoNumber) scope.stylesWithoutPo += 1;
      else scope.stylesBelowCutoff += 1;
      continue;
    }
    if (cell.poSeq === null) scope.stylesWithUnparseablePo += 1;
    scope.stylesInScope += 1;
    cells.set(styleId, cell);
  }

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

  scope.distinctLabelsBefore = labelsBefore.size;
  scope.distinctLabelsAfter = labels.length;
  scope.distinctLabelsDropped = Math.max(0, labelsBefore.size - labels.length);

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
    scope,
    totals: { styles: cells.size, stylesWithTrims, distinctLabels: labels.length },
  };
}

// ---------------------------------------------------------------------------
// The purge preview.
//
// Stored per-label decisions were made against the UNSCOPED vocabulary, so some
// of them settle words that only ever appeared on orders we will never print.
// A person about to drop the lot should see exactly what is in it and how much
// of it is still live, which is what this returns — same single pluck query as
// the census, no layouts and no ProdSpecs, because the question is only "which
// of these words still occur".
// ---------------------------------------------------------------------------

export type StoredOverrideSummary = {
  normalized: string;
  concepts: string[];
  // Styles carrying this label that generation would actually reach.
  stylesInScope: number;
  // Styles carrying it that the cutoff (or a missing PO) parks.
  stylesOutOfScope: number;
  // Occurs ONLY outside the scope — the archaeology the wash exists to remove.
  outOfScopeOnly: boolean;
};

export type TrimOverridePurgePreview = {
  cutoff: number | null;
  total: number;
  // Of `total`, how many settle vocabulary that no in-scope style uses.
  outOfScopeOnly: number;
  entries: StoredOverrideSummary[];
};

export async function buildOverridePurgePreview(
  overrides: Record<string, string[]>,
): Promise<TrimOverridePurgePreview> {
  const keys = Object.keys(overrides);
  if (keys.length === 0) {
    return { cutoff: await getGenerationMinPo(), total: 0, outOfScopeOnly: 0, entries: [] };
  }

  const cutoff = await getGenerationMinPo();
  const cells = await loadTrimCells();
  const inScope = new Map<string, number>();
  const outOfScope = new Map<string, number>();
  for (const cell of cells.values()) {
    const bucket = isStyleInGenerationScope(cell, cutoff) ? inScope : outOfScope;
    for (const label of splitTrimsCell(cell.raw)) {
      const key = normalizeTrimLabel(label);
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
  }

  const entries: StoredOverrideSummary[] = keys
    .map((normalized) => {
      const stylesInScope = inScope.get(normalized) ?? 0;
      const stylesOutOfScope = outOfScope.get(normalized) ?? 0;
      return {
        normalized,
        concepts: overrides[normalized] ?? [],
        stylesInScope,
        stylesOutOfScope,
        outOfScopeOnly: stylesInScope === 0,
      };
    })
    // Worst first: the decisions that no longer describe anything live.
    .sort((a, b) => a.stylesInScope - b.stylesInScope || b.stylesOutOfScope - a.stylesOutOfScope);

  return {
    cutoff,
    total: entries.length,
    outOfScopeOnly: entries.filter((e) => e.outOfScopeOnly).length,
    entries,
  };
}

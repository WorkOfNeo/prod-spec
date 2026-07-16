import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { outputReadinessForStyle, type ReadinessStyle } from "@/lib/styles/output-readiness";
import { loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { baseVariantKey } from "@/lib/tickets/orphan";

// =====================================================
// Per-output (base variantKey) snapshot for the rejection workbench: what the
// ProdSpec currently declares + the bundle framing pages, each lined up with
// its newest generated asset. This is the "when was each output last made"
// data the rejection log needs to show freshness ("regenerated since the
// rejection?") and to drive the smart style-level mark-fixed.
//
// One row per OUTPUT SLOT — multi-document outputs ("<base>#<suffix>", a
// carton X-of-Y or a per-EAN washcare label) collapse to their base, taking
// the NEWEST asset time across their documents. Pure read; shared by the page
// (display) and resolveStyleRejections (decisions) so the two never drift.
// =====================================================

const FRAMING_NAMES: Record<string, string> = {
  __cover__: "Cover page",
  __general_info__: "General information",
};

export type StyleOutputBase = {
  // Base variantKey (no "#<suffix>").
  variantKey: string;
  name: string;
  docType: string | null;
  // Can it be (re)generated right now? Framing pages are always renderable;
  // declared outputs gate on their own required fields.
  ready: boolean;
  // Missing field labels when not ready (e.g. "Description", "KL number").
  missing: string[];
  // Skipped by a doc-type keyword rule (e.g. socks → no wash care). When true
  // the output is intentionally never generated; `exclusionReason` is the rule.
  excluded: boolean;
  exclusionReason: string | null;
  // Part of the ProdSpec's current output set (false ⇒ framing or an output
  // that's since been removed but still has assets).
  declared: boolean;
  // Newest non-FAILED asset for this slot, null if never generated.
  lastGeneratedAt: Date | null;
  // Review state of that newest asset (APPROVED / REJECTED / PENDING_REVIEW).
  latestReviewStatus: string | null;
};

// The "why isn't this output generated" line — the SAME text the review screens
// show, reused wherever the rejection log lists an output. Excluded wins (it's a
// hard rule); otherwise a not-ready output lists its missing Monday fields.
// Returns null when the output generates fine.
export function notGeneratedReason(o: {
  excluded: boolean;
  exclusionReason: string | null;
  ready: boolean;
  missing: string[];
}): string | null {
  if (o.excluded) {
    return o.exclusionReason ?? "Not generated — skipped by a document-type rule for this product.";
  }
  if (!o.ready && o.missing.length > 0) {
    return `Missing fields, output could not be generated. Please fill these in Monday: ${o.missing.join(", ")}`;
  }
  return null;
}

export async function styleOutputBases(styleId: string): Promise<StyleOutputBase[]> {
  // `layout:<id>` outputs resolve their readiness from the variant registry.
  await ensureLayoutVariantsLoaded();

  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      rawData: true,
      poNumber: true,
      cartonEan: true,
      supplier: { select: { country: true } },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, cartonEan: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { outputs: true, columnMapping: true } },
    },
  });
  if (!style) return [];

  // Pass the doc-type keyword rules + per-style operator ignores so excluded
  // outputs (socks → no wash care, or an output ignored for this style) carry
  // their `excluded`/`exclusionReason` — the rejection log surfaces the SAME
  // "not generated — <reason>" text the review screens show.
  const [exclusionRules, docTypeLabels, ignoredKeys] = await Promise.all([
    loadDocTypeExclusionRules(),
    loadDocTypeLabels(),
    loadIgnoredOutputKeys(styleId),
  ]);
  const readiness = outputReadinessForStyle(
    style as ReadinessStyle,
    exclusionRules,
    docTypeLabels,
    ignoredKeys,
  );
  const readinessByBase = new Map(readiness.map((r) => [baseVariantKey(r.variantKey), r]));

  // Newest non-FAILED asset per base. Assets are ordered newest-first, so the
  // first time we see a base is its latest document.
  const assets = await db.jobAsset.findMany({
    where: { job: { styleId, status: { not: "FAILED" } }, variantKey: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { variantKey: true, createdAt: true, reviewStatus: true, docType: true },
  });
  const latestByBase = new Map<string, { createdAt: Date; reviewStatus: string; docType: string }>();
  for (const a of assets) {
    if (!a.variantKey) continue;
    const b = baseVariantKey(a.variantKey);
    if (!latestByBase.has(b)) {
      latestByBase.set(b, { createdAt: a.createdAt, reviewStatus: a.reviewStatus, docType: a.docType });
    }
  }

  // Declared outputs first (spec order), then framing / removed-but-generated.
  const bases = [...readinessByBase.keys(), ...latestByBase.keys()];
  const seen = new Set<string>();
  const out: StyleOutputBase[] = [];
  for (const b of bases) {
    if (seen.has(b)) continue;
    seen.add(b);
    const r = readinessByBase.get(b);
    const a = latestByBase.get(b);
    out.push({
      variantKey: b,
      name: r?.name ?? FRAMING_NAMES[b] ?? a?.docType ?? b,
      docType: a?.docType ?? null,
      ready: r?.ready ?? true,
      missing: (r?.missing ?? []).map((m) => m.label),
      excluded: r?.excluded === true,
      exclusionReason: r?.exclusionReason ?? null,
      declared: r !== undefined,
      lastGeneratedAt: a?.createdAt ?? null,
      latestReviewStatus: a?.reviewStatus ?? null,
    });
  }
  return out;
}

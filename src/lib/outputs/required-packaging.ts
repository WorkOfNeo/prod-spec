import type { BundleDocSummary } from "@/lib/pdf/bundle-pages";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";

// =====================================================
// "Required packaging" for the cover page — every packaging output the style's
// ProdSpec declares (minus the ones excluded/ignored for THIS style), each
// listed once with its printed size and whether its layout is APPROVED yet.
//
// The cover is what the supplier receives, so it doubles as a manifest: the
// supplier sees the whole set of layouts to expect, with a confirmed size on
// the ones Contrast has approved and an "Awaiting Contrast confirmation" flag on
// the ones still in review — so a later delivery of the pending layouts is no
// surprise. See renderCoverPageHtml in src/lib/pdf/bundle-pages.ts.
//
// The pure assembler (assembleRequiredPackagingDocs) is DB-free so it can be
// unit-tested and called synchronously by the runner (which already resolved
// each output's variant + dims). buildRequiredPackagingForStyle is the DB read
// that resolves the declared set + live approval state from a style id alone —
// it lazy-imports the DB + registry + readiness chain so importing this module
// never pulls the DB in (mirrors src/lib/outputs/current-outputs.ts).
// =====================================================

const baseKeyOf = (variantKey: string): string => variantKey.split("#")[0];

const isFramingKey = (variantKey: string): boolean => {
  const b = baseKeyOf(variantKey);
  return b === COVER_VARIANT_KEY || b === GENERAL_INFO_VARIANT_KEY;
};

// One resolved output row before the approval flag is applied — the caller has
// already looked up the variant (display name, multi-doc-ness) and resolved the
// printed dimensions.
export type RequiredPackagingRow = {
  variantKey: string;
  displayName: string;
  widthMm: number;
  heightMm: number;
  fileCount: number | null;
};

// Pure: stamp each row with its approval flag and drop the bundle framing pages.
// `approvedBaseKeys` is the set of BASE variantKeys whose current documents are
// all approved + print-safe (approvedOutputBaseKeysForStyle / the runner's
// durable-approval set) — a row is approved iff its base is in there.
export function assembleRequiredPackagingDocs(
  rows: RequiredPackagingRow[],
  approvedBaseKeys: ReadonlySet<string>,
): BundleDocSummary[] {
  return rows
    .filter((r) => !isFramingKey(r.variantKey))
    .map((r) => ({
      displayName: r.displayName,
      widthMm: r.widthMm,
      heightMm: r.heightMm,
      fileCount: r.fileCount,
      approved: approvedBaseKeys.has(baseKeyOf(r.variantKey)),
    }));
}

// DB read. The style's required-packaging rows with live approval state.
//   • Declared/required set + display names come from the ProdSpec outputs,
//     minus outputs excluded by a doc-type keyword rule or ignored for this
//     style (resolved via the same readiness core the runner uses, so the
//     cover and the review screen never disagree on what's required).
//   • Printed sizes via effectiveOutputDims (info-area picks honoured).
//   • Approval state = `approvedBaseKeysOverride` when given (the runner passes
//     its already-loaded durable-approval set — the current job's fresh assets
//     aren't persisted yet, so a DB read here would miss them), otherwise the
//     live cross-job set from approvedOutputBaseKeysForStyle.
export async function buildRequiredPackagingForStyle(
  styleId: string,
  opts?: { approvedBaseKeysOverride?: ReadonlySet<string> },
): Promise<BundleDocSummary[]> {
  const { db } = await import("@/lib/db");
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  const { outputReadinessForStyle } = await import("@/lib/styles/output-readiness");
  const { loadDocTypeExclusionRules, loadDocTypeLabels } = await import("@/lib/pdf/doc-types-db");
  const { loadIgnoredOutputKeys } = await import("@/lib/outputs/output-ignores");
  const { loadStyleFieldValues } = await import("@/lib/outputs/output-field-values");
  const { approvedOutputBaseKeysForStyle } = await import("@/lib/outputs/current-outputs");
  const { getVariant } = await import("@/lib/pdf/template-registry");
  const { effectiveOutputDims, loadInfoAreaSizeMap } = await import("@/lib/prod-spec/info-area");
  const { parseProdSpecOutputs } = await import("@/lib/prod-spec/config");

  // ProdSpec.outputs may reference Output Builder layouts (`layout:<id>`) — load
  // them before the readiness walk resolves variants (names, isInfoArea).
  await ensureLayoutVariantsLoaded();

  const [exclusionRules, docTypeLabels, ignoredKeys, fieldValues, sizeMap] = await Promise.all([
    loadDocTypeExclusionRules(),
    loadDocTypeLabels(),
    loadIgnoredOutputKeys(styleId),
    loadStyleFieldValues(styleId),
    loadInfoAreaSizeMap(),
  ]);

  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      rawData: true,
      poNumber: true,
      cartonEan: true,
      supplier: { select: { country: true } },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { outputs: true, columnMapping: true } },
    },
  });
  if (!style) return [];

  const enabledOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []).filter(
    (o) => o.enabled !== false,
  );
  if (enabledOutputs.length === 0) return [];

  // Bases skipped for this style (doc-type keyword rule or operator ignore) —
  // never "required packaging", so they drop off the cover.
  const readiness = outputReadinessForStyle(
    style,
    exclusionRules,
    docTypeLabels,
    ignoredKeys,
    fieldValues,
  );
  const excludedBaseKeys = new Set(
    readiness.filter((r) => r.excluded === true).map((r) => baseKeyOf(r.variantKey)),
  );

  const rows: RequiredPackagingRow[] = enabledOutputs
    .filter((o) => !excludedBaseKeys.has(baseKeyOf(o.variantKey)))
    .map((o) => {
      const variant = getVariant(o.variantKey);
      const dims = effectiveOutputDims(o, variant?.isInfoArea ?? false, sizeMap);
      return {
        variantKey: o.variantKey,
        displayName: variant?.name ?? o.variantKey,
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        // Multi-document variants (repeat-per-EAN) only know their count against
        // a real render — the cover lists the output once regardless.
        fileCount: variant?.renderMany ? null : 1,
      };
    });

  const approvedBaseKeys =
    opts?.approvedBaseKeysOverride ?? (await approvedOutputBaseKeysForStyle(styleId));

  return assembleRequiredPackagingDocs(rows, approvedBaseKeys);
}

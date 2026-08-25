import type { BundleDocSummary } from "@/lib/pdf/bundle-page-keys";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { classifyLayoutName } from "@/lib/trims/classify";
import { assembleTrimManifest, type ManifestOutput } from "@/lib/trims/manifest";
import type { TrimContext } from "@/lib/trims/style-trims";

// =====================================================
// "Required packaging" for the cover page.
//
// The manifest is the UNION of two lists:
//   * every packaging output the style's ProdSpec declares (minus the ones
//     excluded/ignored for THIS style), and
//   * every entry in the style's Monday "Trims" column.
//
// It used to be the first list alone, which is why a supplier could receive a
// three-line cover for an eight-item order: anything supplied outside this app
// — main labels, hangtags, hangers, polybags — was simply invisible. The two
// lists are joined through a trim CONCEPT rather than by name (see
// src/lib/trims/), so a Monday entry finds its output whatever the layout is
// called and whichever customer it belongs to. See assembleTrimManifest for
// why it is a union in both directions.
//
// With no trim context — an editor preview, or a style whose Trims cell is
// empty — the result is exactly the declared output set, unchanged.
//
// The pure assembler (assembleRequiredPackagingDocs) is DB-free so it can be
// unit-tested and called synchronously by the runner (which already resolved
// each output's variant + dims). buildRequiredPackagingForStyle is the DB read
// that resolves the declared set + live approval state + the trim context from
// a style id alone — it lazy-imports the DB + registry + readiness chain so
// importing this module never pulls the DB in (mirrors
// src/lib/outputs/current-outputs.ts).
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

// The concept an output satisfies: a stored per-layout decision first (the
// escape hatch for a name the rules can't read), then the layout's own name.
// An override stored as "" means "this document answers no trim" and is
// honoured — hence the key-presence check rather than a truthiness one.
function conceptForOutput(row: RequiredPackagingRow, ctx: TrimContext): string | null {
  const base = baseKeyOf(row.variantKey);
  if (Object.prototype.hasOwnProperty.call(ctx.layoutConcepts, base)) {
    return ctx.layoutConcepts[base] || null;
  }
  return classifyLayoutName(row.displayName, ctx.rules);
}

// Pure: stamp each row with its approval flag, drop the bundle framing pages,
// and fold in the style's Monday trims when a context is supplied.
// `approvedBaseKeys` is the set of BASE variantKeys whose current documents are
// all approved + print-safe (approvedOutputBaseKeysForStyle / the runner's
// durable-approval set) — a row is approved iff its base is in there.
export function assembleRequiredPackagingDocs(
  rows: RequiredPackagingRow[],
  approvedBaseKeys: ReadonlySet<string>,
  trimContext?: TrimContext,
): BundleDocSummary[] {
  const outputs = rows.filter((r) => !isFramingKey(r.variantKey));

  // No context ⇒ the pre-Trims behaviour, byte for byte. The layout editor's
  // preview renders a cover with no style behind it, so it has no trims to fold
  // in and must not start printing empty rows.
  if (!trimContext) {
    return outputs.map((r) => ({
      displayName: r.displayName,
      widthMm: r.widthMm,
      heightMm: r.heightMm,
      fileCount: r.fileCount,
      approved: approvedBaseKeys.has(baseKeyOf(r.variantKey)),
    }));
  }

  const manifestOutputs: ManifestOutput[] = outputs.map((r) => ({
    variantKey: r.variantKey,
    displayName: r.displayName,
    widthMm: r.widthMm,
    heightMm: r.heightMm,
    fileCount: r.fileCount,
    approved: approvedBaseKeys.has(baseKeyOf(r.variantKey)),
    concept: conceptForOutput(r, trimContext),
  }));

  return assembleTrimManifest({
    trimLabels: trimContext.trimLabels,
    outputs: manifestOutputs,
    rules: trimContext.rules,
    overrides: trimContext.overrides,
    manualDelivered: trimContext.manualDelivered,
  });
}

// The trim configuration, loaded once. Separate from the per-style read because
// the three settings blobs are global: a caller resolving several styles (the
// regen sweep, the coverage report) loads this once and threads it, rather than
// hitting AppSetting three times per style.
export async function loadTrimSettings(): Promise<Omit<TrimContext, "trimLabels" | "manualDelivered">> {
  const { getTrimRules, getTrimLabelOverrides, getTrimLayoutConcepts } = await import(
    "@/lib/settings/app-settings"
  );
  const [rules, overrides, layoutConcepts] = await Promise.all([
    getTrimRules(),
    getTrimLabelOverrides(),
    getTrimLayoutConcepts(),
  ]);
  return { rules, overrides, layoutConcepts };
}

// DB read. The style's required-packaging rows with live approval state.
//   * Declared/required set + display names come from the ProdSpec outputs,
//     minus outputs excluded by a doc-type keyword rule or ignored for this
//     style (resolved via the same readiness core the runner uses, so the
//     cover and the review screen never disagree on what's required).
//   * Printed sizes via effectiveOutputDims (info-area picks honoured).
//   * Approval state = `approvedBaseKeysOverride` when given (the runner passes
//     its already-loaded durable-approval set — the current job's fresh assets
//     aren't persisted yet, so a DB read here would miss them), otherwise the
//     live cross-job set from approvedOutputBaseKeysForStyle.
//   * Monday's Trims entries for the style, folded in through the concept map.
export async function buildRequiredPackagingForStyle(
  styleId: string,
  opts?: {
    approvedBaseKeysOverride?: ReadonlySet<string>;
    // Pre-loaded by callers resolving many styles in one pass.
    trimSettings?: Omit<TrimContext, "trimLabels" | "manualDelivered">;
    // Render the pre-Trims manifest. Used by the before/after preview to show
    // what a cover says TODAY against what it would say once trims are folded
    // in — the two halves of the diff have to come from one code path or the
    // comparison is meaningless.
    withoutTrims?: boolean;
    // Fold trims in even though the master switch is off. ONLY the before/after
    // preview passes this: its entire job is to show what turning the switch on
    // would do, so it must not be gated by the switch it is there to inform.
    // Nothing that writes a PDF may pass it.
    forceTrims?: boolean;
  },
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
  const { resolveStyleTrimLabels } = await import("@/lib/trims/style-trims");
  const { getTrimsOnCoverEnabled } = await import("@/lib/settings/app-settings");

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
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, cartonEan: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { outputs: true, columnMapping: true } },
    },
  });
  if (!style) return [];

  const enabledOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []).filter(
    (o) => o.enabled !== false,
  );

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

  // The master switch. Off (the default) means every cover renders exactly as
  // it did before trims existed — same rows, same fingerprint — so shipping
  // this code changes nothing a supplier sees until somebody decides it should.
  const trimsEnabled = opts?.forceTrims === true || (await getTrimsOnCoverEnabled());

  // The pre-Trims manifest: no declared outputs meant no manifest at all.
  // Trims changes that — a style with no outputs can still owe the supplier a
  // list of what to expect — so the early return only applies without them.
  if (opts?.withoutTrims || !trimsEnabled) {
    if (rows.length === 0) return [];
    const approvedBaseKeys =
      opts?.approvedBaseKeysOverride ?? (await approvedOutputBaseKeysForStyle(styleId));
    return assembleRequiredPackagingDocs(rows, approvedBaseKeys);
  }

  const trimLabels = resolveStyleTrimLabels(style);
  if (rows.length === 0 && trimLabels.length === 0) return [];

  const settings = opts?.trimSettings ?? (await loadTrimSettings());
  const approvedBaseKeys =
    opts?.approvedBaseKeysOverride ?? (await approvedOutputBaseKeysForStyle(styleId));

  return assembleRequiredPackagingDocs(rows, approvedBaseKeys, { ...settings, trimLabels });
}

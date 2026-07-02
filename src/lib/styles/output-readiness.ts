import { db, type DbClient } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { parseProdSpecColumnMapping, parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { getVariant } from "@/lib/pdf/template-registry";
import { pinnedColumnKeys } from "@/lib/pdf/pins-meta";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { loadDocTypeExclusionRules } from "@/lib/pdf/doc-types-db";
import {
  matchExclusionRules,
  exclusionReasonText,
  type DocTypeRulesMap,
} from "@/lib/outputs/exclusion";
import { IGNORED_EXCLUSION_REASON, loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import type { MondayItem } from "@/lib/monday/client";
import { effectiveStyleItem, resolveMappedField, STYLE_FIELD_LABELS } from "./resolved-fields";
import type { DetailFieldKey, MissingDetailField } from "./detail-fields";

// =====================================================
// Per-output readiness. An output (template variant) is "ready" when every
// field IT declares (template-registry `requiredFields`) resolves to a value
// on the style. This replaces the old all-or-nothing union gate: each output
// generates as soon as its own fields land on the pre-order row, instead of
// waiting for the slowest output's fields.
// =====================================================

export type OutputReadiness = {
  variantKey: string;
  name: string;
  ready: boolean;
  missing: MissingDetailField[];
  // A doc-type keyword rule matched this style — OR the operator ignored the
  // output for this style — so it won't be generated (and that's intentional).
  // When excluded, `ready`/`missing` are moot — callers treat the output as
  // decided, not as pending work.
  excluded?: boolean;
  exclusionReason?: string;
  // Set alongside `excluded` when the exclusion is a per-style operator ignore
  // (StyleOutputIgnore) rather than a doc-type rule — the UI shows a distinct
  // "Ignored" pill with an undo, everything else treats both the same.
  ignored?: boolean;
};

// The minimal style shape readiness needs. Mirrors what the auto-enqueue
// paths and the runner already load.
export type ReadinessStyle = {
  rawData: unknown;
  poNumber?: string | null;
  supplier?: { country?: string | null } | null;
  // Resolved PO barcodes — feed the ean13/cartonEan fallbacks so an output
  // that needs EANs reads "ready" once the PO PDF has been scraped.
  eans?: ReadonlyArray<{ size: string; ean13: string | null }> | null;
  cartonEan?: string | null;
  customer: { config: unknown };
  prodSpec: { outputs: unknown; columnMapping: unknown } | null;
};

// The effective field mapping the runner actually reads through: the
// ProdSpec.columnMapping override when it carries any keys, otherwise the
// Customer mapping. Mirrors runner.ts so readiness and the real render agree.
// Exported so the exclusion match resolves fields identically everywhere.
export function effectiveMapping(style: ReadinessStyle): ColumnMapping {
  const customerMapping = parseCustomerConfig(style.customer.config).columnMapping;
  const psRaw = style.prodSpec?.columnMapping;
  const hasProdSpecMapping =
    psRaw !== null && typeof psRaw === "object" && Object.keys(psRaw as object).length > 0;
  return hasProdSpecMapping ? parseProdSpecColumnMapping(psRaw) : customerMapping;
}

// Per ENABLED output on the style's ProdSpec: is every field that output
// needs filled? Returns [] when there's no ProdSpec or no enabled outputs.
//
// Two refinements on top of the static per-variant `requiredFields`:
//   • Branch-aware gates — a variant with a `readiness` hook (declarative
//     switch bindings, e.g. the FOB/DDP order-number rule) requires only
//     the columns its TAKEN branch reads.
//   • Pins — a field pinned on the output entry (`fieldOverrides`, set in
//     the ProdSpec editor) counts as satisfied: the pinned constant renders
//     regardless of the row.
export function outputReadinessForStyle(
  style: ReadinessStyle,
  // Doc-type keyword exclusion rules (loadDocTypeExclusionRules). Optional so
  // existing callers stay exclusion-agnostic; pass them to mark outputs whose
  // type matches as excluded. `docTypeLabels` only flavours the reason text.
  rules?: DocTypeRulesMap,
  docTypeLabels?: Record<string, string>,
  // Per-style operator ignores (loadIgnoredOutputKeys) — base variantKeys the
  // operator marked "not wanted for this style". Marked excluded like a rule
  // hit, plus `ignored: true` so the UI can tell them apart.
  ignoredKeys?: ReadonlySet<string>,
): OutputReadiness[] {
  const enabledOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []).filter(
    (o) => o.enabled !== false,
  );
  if (enabledOutputs.length === 0) return [];

  const mapping = effectiveMapping(style);
  const item = effectiveStyleItem(style) as MondayItem | null;
  const resolve = (f: keyof ColumnMapping) => resolveMappedField(item, mapping, f);
  const hasRules = rules != null && Object.keys(rules).length > 0;

  return enabledOutputs.map((output) => {
    const variant = getVariant(output.variantKey);
    const pinned = pinnedColumnKeys(output.fieldOverrides);
    const keys = (variant?.readiness
      ? variant.readiness(resolve)
      : (variant?.requiredFields ?? [])) as DetailFieldKey[];
    const missing = keys
      .filter((f) => !pinned.has(f) && !resolve(f).trim())
      .map((f) => ({ field: f, label: STYLE_FIELD_LABELS[f] }));
    // Exclusion: does this output's document type carry a keyword rule that
    // matches the style? Resolved through the SAME field resolver as
    // readiness, so the runner (which also calls this) and the review page
    // can never disagree on whether an output is skipped.
    const docType = variant?.docType;
    const hit =
      hasRules && docType
        ? matchExclusionRules(rules[docType], (f) => resolve(f as keyof ColumnMapping))
        : null;
    // An explicit per-style ignore wins over (and reads clearer than) a rule
    // hit — both mark the output excluded either way.
    const isIgnored = ignoredKeys?.has(output.variantKey) === true;
    return {
      variantKey: output.variantKey,
      name: variant?.name ?? output.variantKey,
      ready: missing.length === 0,
      missing,
      ...(isIgnored
        ? { excluded: true, ignored: true, exclusionReason: IGNORED_EXCLUSION_REASON }
        : hit
          ? {
              excluded: true,
              exclusionReason: exclusionReasonText(
                hit,
                docTypeLabel(docType ?? "", docTypeLabels),
              ),
            }
          : {}),
    };
  });
}

// The output keys an auto-enqueue should kick off now: outputs that are ready
// MINUS outputs already generated for this style. "Already generated" = a
// distinct variantKey among the style's JobAssets that isn't on a FAILED job,
// so we don't redo work that's already awaiting review or approved.
export async function pendingOutputKeysForStyle(
  styleId: string,
  // Transaction client for atomic / rollback-test callers; defaults to the
  // global `db`. Layout-variant loading below always uses the global client
  // (published layouts are reference data, fine to read outside any tx).
  client: DbClient = db,
): Promise<string[]> {
  // ProdSpec.outputs may reference Output Builder layouts (`layout:<id>`
  // keys) — make sure they're in the registry before the sync readiness
  // walk below resolves variants.
  await ensureLayoutVariantsLoaded();

  const style = await client.style.findUnique({
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

  // Exclusion-aware: an excluded output is "ready" (its fields resolve) but
  // must NEVER be enqueued — the runner would skip it, leaving it un-generated
  // and forever "pending", which would re-trigger auto-runs (and NO_OUTPUTS
  // failures when it's the only one left). Treat excluded as not-pending.
  // Per-style operator ignores are excluded the same way.
  const [rules, ignoredKeys] = await Promise.all([
    loadDocTypeExclusionRules(),
    loadIgnoredOutputKeys(styleId, client),
  ]);
  const ready = outputReadinessForStyle(style, rules, undefined, ignoredKeys)
    .filter((o) => o.ready && !o.excluded)
    .map((o) => o.variantKey);
  if (ready.length === 0) return [];

  const existing = await client.jobAsset.findMany({
    where: {
      job: { styleId, status: { not: "FAILED" } },
      variantKey: { not: null },
    },
    select: { variantKey: true },
  });
  const generated = new Set(
    existing
      .map((a) => a.variantKey)
      .filter((k): k is string => Boolean(k))
      // Multi-document assets are "<variantKey>#<suffix>" — compare bases.
      .map((k) => k.split("#")[0]),
  );
  return ready.filter((k) => !generated.has(k));
}

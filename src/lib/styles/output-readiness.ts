import { db } from "@/lib/db";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { parseProdSpecColumnMapping, parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { getVariant } from "@/lib/pdf/template-registry";
import { pinnedColumnKeys } from "@/lib/pdf/pins-meta";
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
function effectiveMapping(style: ReadinessStyle): ColumnMapping {
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
export function outputReadinessForStyle(style: ReadinessStyle): OutputReadiness[] {
  const enabledOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []).filter(
    (o) => o.enabled !== false,
  );
  if (enabledOutputs.length === 0) return [];

  const mapping = effectiveMapping(style);
  const item = effectiveStyleItem(style) as MondayItem | null;
  const resolve = (f: keyof ColumnMapping) => resolveMappedField(item, mapping, f);

  return enabledOutputs.map((output) => {
    const variant = getVariant(output.variantKey);
    const pinned = pinnedColumnKeys(output.fieldOverrides);
    const keys = (variant?.readiness
      ? variant.readiness(resolve)
      : (variant?.requiredFields ?? [])) as DetailFieldKey[];
    const missing = keys
      .filter((f) => !pinned.has(f) && !resolve(f).trim())
      .map((f) => ({ field: f, label: STYLE_FIELD_LABELS[f] }));
    return {
      variantKey: output.variantKey,
      name: variant?.name ?? output.variantKey,
      ready: missing.length === 0,
      missing,
    };
  });
}

// The output keys an auto-enqueue should kick off now: outputs that are ready
// MINUS outputs already generated for this style. "Already generated" = a
// distinct variantKey among the style's JobAssets that isn't on a FAILED job,
// so we don't redo work that's already awaiting review or approved.
export async function pendingOutputKeysForStyle(styleId: string): Promise<string[]> {
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

  const ready = outputReadinessForStyle(style)
    .filter((o) => o.ready)
    .map((o) => o.variantKey);
  if (ready.length === 0) return [];

  const existing = await db.jobAsset.findMany({
    where: {
      job: { styleId, status: { not: "FAILED" } },
      variantKey: { not: null },
    },
    select: { variantKey: true },
  });
  const generated = new Set(
    existing.map((a) => a.variantKey).filter((k): k is string => Boolean(k)),
  );
  return ready.filter((k) => !generated.has(k));
}

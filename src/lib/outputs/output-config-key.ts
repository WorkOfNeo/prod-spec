import type { ProdSpecOutput } from "@/lib/prod-spec/config";

// =====================================================
// Output config fingerprint — a stable string of the RENDER-AFFECTING config
// of a single ProdSpec output. Stamped on each JobAsset at render time
// (JobAsset.outputConfigKey) and recomputed from the current spec when the
// rerun surfaces decide what to run: a difference means the output was edited
// (dims / pins / carton barcode / info-area size) since the asset was built, so
// the printed PDF no longer matches the spec — the output is "changed".
//
// Mirrors the eanResolveKey pattern (src/lib/po/resolve-inputs.ts): a JSON
// array rather than a joined string, so an array boundary in one field can
// never masquerade as another's value. Scope is deliberately the OUTPUT's own
// config only — spec-wide globals (logo / languages / care catalogue) are NOT
// included, so a global tweak doesn't mark every output on every style stale.
// `enabled` and `variantKey` are excluded: toggling an output off just removes
// it, and the key is always compared within the same variant.
// =====================================================

export function outputConfigKey(output: ProdSpecOutput): string {
  // Sort the pin entries so key order in the stored JSON can't change the
  // fingerprint (the editor writes them in insertion order).
  const pins = output.fieldOverrides
    ? Object.entries(output.fieldOverrides).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];

  return JSON.stringify([
    output.widthMm,
    output.heightMm,
    pins,
    output.cartonBarcodeType ?? null,
    output.cartonBarcodeHeightMm ?? null,
    output.infoAreaSizeId ?? null,
  ]);
}

// =====================================================
// Orphaned-ticket detection (PURE — no db / render imports, unit-testable).
//
// A rejection ticket is "orphaned" when the output it was raised against is
// no longer part of its style's ProdSpec — the operator removed or replaced
// that output (e.g. swapped a coded carton print-spec for an Output Builder
// layout). Re-running such a ticket would scope a generation job to a key
// that matches none of the current outputs, which the runner can only turn
// into a NO_OUTPUTS hard-failure. Detecting it lets us resolve the ticket in
// place instead — nothing to regenerate.
//
// Membership is by BASE key: a multi-document ticket key carries a
// "#<suffix>" (layout:<id>#L-ColourA); the ProdSpec output declares the base
// (layout:<id>). Framing keys (cover / general info) are NEVER orphaned —
// they're synthesised on every run, not declared in `outputs`. The legacy
// empty key ("") means "full regen", also never orphaned.
// =====================================================

// Reserved synthetic framing variantKeys — mirror of the constants in
// src/lib/pdf/bundle-pages.ts (COVER_VARIANT_KEY / GENERAL_INFO_VARIANT_KEY).
// Inlined so this stays a zero-dependency pure module (bundle-pages.ts pulls
// in the render pipeline). Kept in lockstep with that one source of truth.
const FRAMING_VARIANT_KEYS = new Set(["__cover__", "__general_info__"]);

export function baseVariantKey(variantKey: string): string {
  return variantKey.split("#")[0];
}

// True when `variantKey`'s output is no longer one of `currentBaseKeys`
// (the base variantKeys the ProdSpec currently declares, enabled or not).
export function isOrphanedOutputKey(variantKey: string, currentBaseKeys: Set<string>): boolean {
  if (!variantKey) return false; // legacy "" → full regen, not output-scoped
  if (FRAMING_VARIANT_KEYS.has(variantKey)) return false;
  return !currentBaseKeys.has(baseVariantKey(variantKey));
}

// The set of base keys a ProdSpec currently declares, from its parsed outputs.
export function currentOutputBaseKeys(outputs: Array<{ variantKey: string }>): Set<string> {
  return new Set(outputs.map((o) => baseVariantKey(o.variantKey)));
}

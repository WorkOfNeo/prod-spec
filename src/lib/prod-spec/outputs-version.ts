// =====================================================
// Output-set change detection (PURE — no db imports, unit-testable).
//
// Answers one question for the ProdSpec PATCH endpoint: did this save ADD an
// output that the spec's styles have never been offered?
//
// Only a GAIN matters. The generation gate is "ready outputs minus already
// generated", so:
//   • an output ADDED, or a disabled one re-ENABLED → every existing style now
//     has a declared output with no asset ⇒ bump, fan it out.
//   • an output REMOVED or DISABLED → nothing to generate; the orphan-ticket
//     cleanup in the PATCH route already handles the fallout ⇒ no bump.
//   • geometry / pins / barcode prefs edited on an EXISTING output → that's the
//     "changed" bucket (outputConfigKey), which deliberately does NOT
//     auto-regenerate: re-rendering approved and in-review PDFs because someone
//     nudged a millimetre is exactly the blast radius we're avoiding ⇒ no bump.
//
// Comparing by BASE key matches how assets are deduped everywhere else (a
// multi-document output writes "<base>#<suffix>" assets against one declared
// base key).
// =====================================================

import { baseVariantKey } from "@/lib/tickets/orphan";

type OutputLike = { variantKey: string; enabled?: boolean };

// Base keys of the outputs that would actually render. `enabled` defaults to
// true in ProdSpecOutputSchema, so an absent flag counts as on.
export function enabledBaseKeys(outputs: OutputLike[]): Set<string> {
  return new Set(
    outputs.filter((o) => o.enabled !== false).map((o) => baseVariantKey(o.variantKey)),
  );
}

// The enabled base keys `next` has that `prev` did not — the outputs a save
// just introduced. Empty ⇒ nothing new to fan out.
export function gainedOutputKeys(prev: OutputLike[], next: OutputLike[]): string[] {
  const before = enabledBaseKeys(prev);
  return [...enabledBaseKeys(next)].filter((k) => !before.has(k));
}

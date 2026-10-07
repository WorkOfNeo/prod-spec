import { DEFAULT_OUTPUTS, parseProdSpecOutputs, type ProdSpecOutput } from "@/lib/prod-spec/config";

// The runner's output-selection rule, lifted out so the test pins the real
// thing rather than a hand-kept copy.
//
// ProdSpec.outputs is the source of truth: the operator selected those
// explicitly in the editor, and every ENABLED one renders.
//
// cover-only means "an empty Outputs list is deliberate — produce the cover
// and don't fail". It does NOT veto outputs that are configured: a customer
// who supplies their own layouts today may start using ours tomorrow, and the
// tick left on from the cover-only days must not silently swallow the outputs
// someone has since added. (It used to, and pendingOutputKeysForStyle — which
// doesn't know about the flag — then saw those outputs as forever pending and
// re-enqueued the style on every sync.)
//
// The flag still suppresses the fallback: with no enabled outputs, a cover-only
// spec selects nothing rather than DEFAULT_OUTPUTS. DEFAULT_OUTPUTS is empty
// today (src/lib/prod-spec/config.ts), so without the flag an empty spec ends
// in NO_OUTPUTS — empty still means "somebody forgot" for every spec that has
// not opted in.
export function selectRunOutputs(
  prodSpec: { outputs: unknown; coverOnly?: boolean | null } | null,
): ProdSpecOutput[] {
  if (prodSpec) {
    const enabled = parseProdSpecOutputs(prodSpec.outputs).filter((o) => o.enabled !== false);
    if (enabled.length > 0) return enabled;
  }
  // Only a literal true counts — a JSON round trip handing back "true" or 1
  // must not switch a mode on.
  if (prodSpec?.coverOnly === true) return [];
  return DEFAULT_OUTPUTS;
}

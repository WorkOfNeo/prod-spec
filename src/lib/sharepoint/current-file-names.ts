import { getVariant } from "@/lib/pdf/template-registry";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { coverFileName } from "@/lib/pdf/cover-file-name";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";

// =====================================================
// "What should this document be called RIGHT NOW?" — resolve a style's already-
// generated documents against their layouts' CURRENT fileName templates.
//
// An output is named ONCE, at generation, and the name is frozen on
// JobAsset.fileName. Every downstream surface reads that stored name: the
// supplier push uploads under it, the verify sweep looks for it, and the folder
// reconcile compares against it. So when a template is edited AFTER an output
// was approved and uploaded, the stored name — and therefore every one of those
// surfaces — keeps describing a file by a name the config no longer agrees with.
// The runner will not regenerate an approved output, so the new name never lands
// on its own.
//
// This module is the single answer to that question, extracted so the three
// callers cannot drift apart:
//   • restamp-file-names.ts — writes the resolved name back to JobAsset.fileName.
//   • reconcile-folder.ts   — compares the folder against the resolved name, so
//                             "is it in SharePoint?" asks about the name the
//                             config means today, not the one it meant in June.
//
// Matching is by the split suffix carried in the variant key
// ("layout:<id>#4-5R-Mix"), the runner's own stable per-document discriminator —
// NEVER by guessing from the stored name. A document whose split row no longer
// exists resolves to `unresolvable`, never to something plausible: renaming a
// file onto a guess is how the wrong artwork ends up under the right name.
// =====================================================

// Why a document has (or hasn't) a current name. The three non-resolved kinds
// are deliberately distinct — a caller must be able to tell "the template says
// nothing" (leave the stored name alone, it is correct) from "we could not work
// it out" (leave the stored name alone, but SAY SO).
export type CurrentNameResolution =
  | { kind: "resolved"; fileName: string } // the template's answer, un-sanitised
  | { kind: "template-default" } // empty template ⇒ the runner default stands and already carries the suffix
  | { kind: "no-template" } // framing page (general info) — never had a template
  | { kind: "unresolvable"; reason: string }; // say why; never guess a name

// The minimum a document has to carry to be nameable. Deliberately NOT the whole
// output row: both callers already hold richer objects, and narrowing here keeps
// this module free of their shapes.
export type NameableDocument = { jobAssetId: string; variantKey: string };

// Resolved names keyed by jobAssetId. A document absent from the map was not in
// `docs`; a document present with a non-"resolved" kind has no current name and
// its stored one must stand.
export type CurrentNameMap = Map<string, CurrentNameResolution>;

// Resolve every document in `docs` against its layout's current template.
//
// `variantsAlreadyFresh` exists because the force-refresh is the expensive part
// (it re-reads every published layout) and a PO-wide reconcile resolves several
// styles in one pass. Default false — refreshing is the safe behaviour, so a
// caller that forgets gets correctness rather than a stale template. A caller
// that has ALREADY called ensureLayoutVariantsLoaded(true) in this request
// passes true to skip the repeat.
//
// Returns an EMPTY map when the style's render context can't be loaded: with no
// style data there are no template answers, and every caller's correct response
// to "no answer" is to leave the stored name alone.
export async function resolveCurrentFileNames(
  styleId: string,
  docs: readonly NameableDocument[],
  opts?: { variantsAlreadyFresh?: boolean },
): Promise<CurrentNameMap> {
  const out: CurrentNameMap = new Map();
  if (docs.length === 0) return out;

  // Force-fresh so a template saved moments ago is the one we resolve against —
  // this whole module exists because stored names go stale, and resolving
  // against a cached variant would reintroduce exactly that.
  if (!opts?.variantsAlreadyFresh) await ensureLayoutVariantsLoaded(true);

  const ctx = await loadStyleRenderContext(styleId);
  if (!ctx) return out;

  // The split plan per base variant key. Building one re-resolves every
  // repetition row, and a split slot asks for the same plan once per document —
  // so cache it, but PER CALL: the plan is a function of this style's data and
  // must never be shared across styles.
  const planCache = new Map<string, Array<{ suffix: string | null; fileName: string | null }> | null>();

  for (const doc of docs) {
    const [baseKey, hashSuffix] = doc.variantKey.split("#");

    // The cover has no layout template, but it DOES have a current name: the
    // bundle's own naming rule, which now carries the style's colour. Resolving
    // it here is what lets a cover be re-named in place — regenerating one
    // instead would re-arm its queue row (enqueueCoverForSupplier clears
    // sentAt) and put the style back into the nightly supplier digest, i.e. an
    // email, for a change that is only ever a rename.
    if (baseKey === COVER_VARIANT_KEY) {
      out.set(doc.jobAssetId, {
        kind: "resolved",
        fileName: coverFileName(ctx.styleData.styleNumber, ctx.styleData.colour),
      });
      continue;
    }

    // Other framing pages (general info) are named by the bundle and have no
    // per-style variation to resolve. Nothing to do, and nothing wrong.
    if (!baseKey.startsWith("layout:")) {
      out.set(doc.jobAssetId, { kind: "no-template" });
      continue;
    }

    let plan = planCache.get(baseKey);
    if (plan === undefined) {
      const variant = getVariant(baseKey);
      plan = variant?.filesPreview?.(ctx.styleData) ?? null;
      planCache.set(baseKey, plan);
    }
    if (!plan) {
      out.set(doc.jobAssetId, {
        kind: "unresolvable",
        reason: "layout variant not loaded (unpublished?)",
      });
      continue;
    }

    let target: string | null | undefined;
    if (plan.length === 1 && plan[0].suffix === null) {
      // Genuinely non-split: one document for the whole style.
      target = plan[0].fileName;
    } else if (hashSuffix) {
      const hit = plan.find((p) => p.suffix != null && p.suffix.toLowerCase() === hashSuffix.toLowerCase());
      if (!hit) {
        out.set(doc.jobAssetId, {
          kind: "unresolvable",
          reason: `split row “${hashSuffix}” no longer exists — re-run this output`,
        });
        continue;
      }
      target = hit.fileName;
    } else {
      // A split layout whose asset carries no suffix: the runner collapsed the
      // split to one document. Only safe when the plan agrees it is single —
      // otherwise we'd be picking one size's name for an unknown size's file.
      if (plan.length !== 1) {
        out.set(doc.jobAssetId, { kind: "unresolvable", reason: "can't tie this document to one split row" });
        continue;
      }
      target = plan[0].fileName;
    }

    // An empty template means the runner's default name applies — that default
    // already carries the split suffix, so there is nothing to correct.
    out.set(doc.jobAssetId, target ? { kind: "resolved", fileName: target } : { kind: "template-default" });
  }

  return out;
}

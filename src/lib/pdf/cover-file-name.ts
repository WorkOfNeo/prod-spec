// =====================================================
// The cover page's file name — one function, because four call sites need the
// SAME answer: the runner's normal bundle pass, the runner's fully-approved
// refresh, the Test tab's dry run, and current-file-names.ts (which resolves
// what a cover SHOULD be called so an existing one can be re-named in place).
// If any of them disagreed the difference would read as drift and the folder
// sweep would rename files back and forth forever.
//
// Why the colour is in the name. "APPROVED LAYOUTS" is PO-scoped, not style-
// scoped, and one PO routinely carries the same style number in several
// colourways as SEPARATE Style rows. Named on the style number alone, every
// colourway of AB10001 resolves to 00-ab10001-cover-page.pdf — so the second
// style's push overwrites the first's and the supplier receives one cover for
// what is really two products. Nothing upstream notices: both styles store a
// cover, both queue rows stamp UPLOADED, and only the folder is short. The
// per-style collision analyser cannot see it either — it compares one style's
// documents against each other, and within one style there is no collision.
//
// The colour source, in order:
//   1. Colour name  — Monday's "Color Name From Client".
//   2. Colour code  — the "🎨 Color Code" dropdown, whose labels are written
//      "*Blue" / "*Yellow". The leading asterisk is a Monday authoring
//      convention, not part of the colour, so it is stripped.
// =====================================================

// Slug shared with the runner's old style-number slug: anything that isn't a
// letter, digit or dash collapses to a dash, lowercased. Applied to the colour
// too so "Navy Blue" can't put a space in a SharePoint file name.
function slug(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

// The printable colour for a style, name first and code as the fallback, with
// the Monday "*" prefix stripped off the code. Returns "" when the style has
// no colour at all — callers treat that as "omit the colour entirely".
export function coverColourLabel(colour?: { name?: string | null; code?: string | null } | null): string {
  const name = (colour?.name ?? "").trim();
  if (name) return name;
  // Only the LEADING asterisks go: a code that legitimately contains one later
  // ("A*2") keeps it, and the trim runs again in case the label is "* Blue".
  return (colour?.code ?? "").trim().replace(/^\*+/, "").trim();
}

// Does the colourway belong in this style's cover name?
//
// A rename is not free: the supplier already holds the old name, so every
// historical style we rename is a file that has to be renamed in SharePoint too
// or left behind as a stale duplicate. So the new shape applies from the PO
// cutoff onwards ONLY, exactly like the supplier-send backfill — the archive
// below the cutoff keeps the name it was delivered under and never churns.
//
// Two deliberate "no" answers, both matching reconcileSupplierSendQueue:
//   • cutoff unset all the way down the fallback chain ⇒ NEVER. The cutoff is
//     the opt-in; without one this must not reach back over the whole book.
//   • poSeq NULL ⇒ never. A style with no parseable PO can't be placed on the
//     timeline, and guessing "recent" would rename exactly the styles nobody
//     can audit against a PO.
export function coverColourApplies(poSeq: number | null | undefined, minPo: number | null): boolean {
  if (minPo === null) return false;
  if (poSeq == null) return false;
  return poSeq >= minPo;
}

export type CoverNameInput = {
  styleNumber: string;
  colour?: { name?: string | null; code?: string | null } | null;
  // The style's PO position and the delivery cutoff. Both required so a call
  // site cannot silently opt out of the gate and start naming covers on a
  // different rule than the resolver that checks them.
  poSeq: number | null | undefined;
  minPo: number | null;
};

// "00-<style>-<colour>-cover-page.pdf" from the cutoff onwards, and the historic
// "00-<style>-cover-page.pdf" below it or when the style has no colour. The 00-
// prefix keeps the cover sorting first in the supplier's folder, which is why
// it is part of the name rather than metadata.
export function coverFileName(input: CoverNameInput): string {
  const colourSlug = coverColourApplies(input.poSeq, input.minPo)
    ? slug(coverColourLabel(input.colour))
    : "";
  // A colour of only punctuation ("-", "*") slugs to dashes and would add a
  // segment carrying no information — treat it as no colour.
  const suffix = colourSlug.replace(/-/g, "") ? `-${colourSlug}` : "";
  return `00-${slug(input.styleNumber)}${suffix}-cover-page.pdf`;
}

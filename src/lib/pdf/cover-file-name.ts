// =====================================================
// The cover page's file name — one function, because three call sites build it
// (the runner's normal bundle pass, the runner's fully-approved refresh, and
// the Test tab's dry run) and a fourth now RESOLVES it after the fact
// (current-file-names.ts, so a cover can be re-named without regenerating).
//
// Why the colour is in the name. "APPROVED LAYOUTS" is PO-scoped, not style-
// scoped, and one PO routinely carries the same style number in several
// colourways as SEPARATE Style rows. Named on the style number alone, every
// colourway of LV60153 resolves to 00-lv60153-cover-page.pdf — so the second
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
// Neither set ⇒ no colour segment at all, so the ~2,200 single-colourway
// styles that never had a colour keep the exact name they have today and
// nothing already delivered is disturbed.
// =====================================================

// Slug shared with the runner's own style-number slug: anything that isn't a
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

// "00-<style>-<colour>-cover-page.pdf", or "00-<style>-cover-page.pdf" when the
// style carries no colour. The 00- prefix keeps the cover sorting first in the
// supplier's folder, which is why it is part of the name rather than metadata.
export function coverFileName(
  styleNumber: string,
  colour?: { name?: string | null; code?: string | null } | null,
): string {
  const colourSlug = slug(coverColourLabel(colour));
  // A colour of only punctuation ("-", "*") slugs to dashes and would add a
  // segment carrying no information — treat it as no colour.
  const suffix = colourSlug.replace(/-/g, "") ? `-${colourSlug}` : "";
  return `00-${slug(styleNumber)}${suffix}-cover-page.pdf`;
}

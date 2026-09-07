// =====================================================
// DB-free, Graph-free leaf: "what SHAPE is this file name?" — the two
// recognisers the /checks page is built on, kept pure so they can be unit
// tested without a DATABASE_URL, a session or a SharePoint credential.
//
// Neither function decides anything on its own. Shape is a cheap filter that
// says "this file is worth asking about"; whether it actually belongs in the
// folder is answered by diffing it against the expected set for the PO (see
// po-checks.ts). Getting that order wrong is how a legitimate cover ends up
// proposed for deletion.
// =====================================================

// Anything cover-page-shaped: the convention coverFileName() writes
// ("00-<style>[-<colour>]-cover-page.pdf") and, deliberately more loosely,
// anything else carrying "cover page" in any of the spellings a person types
// when they drop one in by hand. The looseness is the point — a hand-named
// "Cover Page (2).pdf" is exactly the kind of file this check exists to notice,
// and a false positive here only ever means one extra row for a human to read.
export function looksLikeCoverPage(fileName: string): boolean {
  return /cover[-_ ]?page/i.test(fileName);
}

// The "<style>[-<colour>]" body of a name that follows the convention, or null
// when it does not. Used to attribute an UNRECOGNISED cover to a style: a
// cover for a style number that is not on this PO is a different (and much
// more actionable) finding than a cover we merely can't place.
export function coverNameBody(fileName: string): string | null {
  const m = fileName.match(/^00-(.+?)-cover-page\.pdf$/i);
  return m ? m[1].toLowerCase() : null;
}

// Does a convention body belong to this style? The colour is appended AFTER the
// style slug, so "ab10001" matches both "ab10001" and "ab10001-blue" — but
// never "ab100011", which is a different style number and must not be adopted.
export function coverBodyMentionsStyle(body: string, styleSlug: string): boolean {
  const b = body.toLowerCase();
  const s = styleSlug.toLowerCase();
  if (!s) return false;
  return b === s || b.startsWith(`${s}-`);
}

// A file name that leaked the layout's own id.
//
// An Output Builder layout whose settings.fileName is empty falls back to the
// runner's default, which is built from the variant key — "layout:<id>" — and
// sanitizeFileName then rewrites the colon to a hyphen on the way into
// SharePoint. So the file the supplier receives is named after a database row.
// That is never a name anybody meant to ship, which makes it the single
// highest-signal tell that an output file is misnamed.
//
// Matched on a long alphanumeric run rather than a strict cuid so an id format
// change doesn't silently switch the detector off. The boundary before
// "layout" stops a legitimate word ending in "…layout" from matching.
const LEAKED_LAYOUT_ID = /(^|[^a-z0-9])layout[-:][a-z0-9]{20,}/i;

export function carriesLayoutId(fileName: string): boolean {
  return LEAKED_LAYOUT_ID.test(fileName);
}

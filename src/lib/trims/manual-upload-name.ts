import { coverColourLabel } from "@/lib/pdf/cover-file-name";
import { normalizeTrimLabel } from "./classify";

// =====================================================
// The SharePoint file name for a manually-supplied trim document.
//
// These land in the SAME folder approved outputs do — the PO folder's
// "APPROVED LAYOUTS" subfolder — and that folder is PO-SCOPED, not style-scoped.
// 1,582 of 2,625 live PO folders hold more than one style, and one PO routinely
// carries the same style number in several colourways as SEPARATE Style rows.
// So a name built from the style number alone silently OVERWRITES another
// style's file: both uploads report success, both rows read as delivered, and
// only the folder is short. That is exactly the failure cover-file-name.ts was
// written to close for cover pages, and it applies here for the same reason.
//
// The name therefore carries three things, in falling order of readability:
//
//   <style number>-<colour>-<trim label>-<style key>.<ext>
//
//   • style number + colour — what a human reads. Mirrors the cover's
//     "00-<style>-<colour>-cover-page.pdf" so the two sort together and read
//     alike. Unlike the cover this is NOT gated on the PO cutoff: there are no
//     historical manual uploads to keep a legacy name for, so every one of them
//     gets the full shape from the start.
//   • trim label — slugged from the Monday wording the cover prints for the
//     row, so the supplier can match file to line without opening it.
//   • style key — Style.mondayItemId, which Postgres holds @unique. This is
//     the part that makes the name PROVABLY collision-free: two different Style
//     rows cannot share it, whatever their style number, colour or trim, so two
//     styles on one PO cannot resolve to one name. It is last because it is the
//     least interesting segment to read.
//
// Pure: no db, no Graph, no clock — the rule is the part worth unit-testing,
// and a test should not need a DATABASE_URL to import it.
// =====================================================

// Same slug the cover name uses: anything that isn't a letter, digit or dash
// collapses to a single dash, lowercased, with the edges trimmed. Duplicated
// rather than exported from cover-file-name.ts so this module stays a leaf —
// the shapes are pinned against each other by the tests, not by an import.
function slug(value: string): string {
  return value
    .replace(/[^a-z0-9-]+/gi, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// What a manually-supplied trim document may be. PDF is the overwhelming case;
// the rest are the formats a supplier or a customer's studio actually sends a
// finished artwork or a spec sheet in. Anything else is refused rather than
// uploaded under a name whose extension we then can't trust.
export const MANUAL_TRIM_EXTENSIONS = [
  "pdf",
  "ai",
  "eps",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "doc",
  "docx",
  "xls",
  "xlsx",
] as const;

export type ManualTrimExtension = (typeof MANUAL_TRIM_EXTENSIONS)[number];

// The extension of an uploaded file, lowercased and validated against the list
// above. null ⇒ the file is not something we will put in a supplier's folder.
// Reads the NAME, never the browser-declared MIME type: browsers disagree on
// the type of an .ai or an .eps, and the name is what the supplier sees anyway.
export function manualTrimExtension(originalFileName: string): ManualTrimExtension | null {
  const ext = originalFileName.split(".").pop()?.toLowerCase().trim() ?? "";
  const hit = MANUAL_TRIM_EXTENSIONS.find((e) => e === ext);
  return hit ?? null;
}

export type ManualTrimNameInput = {
  // Style.name — the style number, as everything else in the folder is named.
  styleNumber: string;
  // The style's colourway, resolved exactly as the cover resolves it (name
  // first, then the "*"-prefixed colour code). Absent/blank ⇒ no colour segment.
  colour?: { name?: string | null; code?: string | null } | null;
  // Style.mondayItemId — @unique in the schema, so this is the segment that
  // guarantees two styles on one PO cannot produce the same name.
  styleKey: string;
  // The Monday trim wording, VERBATIM as the cover manifest prints it.
  label: string;
  // The name the operator's file arrived under — read for its extension only.
  originalFileName: string;
};

// Build the name. Returns null when the extension isn't one we accept, so the
// caller refuses the upload rather than inventing an extension.
export function manualTrimFileName(input: ManualTrimNameInput): string | null {
  const ext = manualTrimExtension(input.originalFileName);
  if (!ext) return null;

  const colourSlug = slug(coverColourLabel(input.colour));
  // A label of only punctuation slugs to nothing; fall back to the normalised
  // form (spaces → dashes) and then to a constant, so a segment is never empty.
  const labelSlug = slug(input.label) || slug(normalizeTrimLabel(input.label)) || "trim";

  const segments = [slug(input.styleNumber), colourSlug, labelSlug, slug(input.styleKey)].filter(
    Boolean,
  );

  return `${segments.join("-")}.${ext}`;
}

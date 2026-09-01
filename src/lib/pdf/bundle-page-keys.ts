// Reserved synthetic variantKeys for the bundle pages' JobAsset rows.
// Double-underscore framing keeps them impossible to collide with
// catalogue keys (kebab-case) or Output Builder keys ("layout:<id>"),
// and `@@unique([jobId, variantKey])` holds since each appears once.
//
// These are pure constants split out from bundle-pages.ts (which pulls in the
// render pipeline) so they can be imported by tests and lightweight code
// without that weight. bundle-pages.ts re-exports them for existing callers.
export const COVER_VARIANT_KEY = "__cover__";
export const GENERAL_INFO_VARIANT_KEY = "__general_info__";

// One row of the cover's "Required packaging" manifest.
//
// Lives here, in the import-free leaf, because the manifest is now assembled
// from Monday's Trims column as well as the declared outputs — so the pure
// assembler (src/lib/trims/manifest.ts) and the settings screens need this
// shape without dragging in the render pipeline. bundle-pages.ts re-exports it.
export type BundleDocSummary = {
  // What prints in the Packaging column. Monday's wording verbatim when the row
  // came from the Trims cell, otherwise the output's own display name.
  displayName: string;
  // Finished print size. NULL for a row with no single document behind it — a
  // manually supplied item, a packing instruction, or a Monday entry answered
  // by several documents at once.
  widthMm: number | null;
  heightMm: number | null;
  // PDFs this output produced (renderMany variants emit one per size/EAN).
  // null ⇒ unknown at render time (editor preview) — shown as "—".
  fileCount: number | null;
  // Delivery state. true ⇒ confirmed (an approved layout, or a manually
  // supplied file found in the order folder); false ⇒ still to come, flagged
  // "Waiting for Customer Information" so the supplier expects it;
  // undefined ⇒ no delivery state applies — the editor preview, and every
  // packing-instruction row (nothing will ever be delivered for a hanger).
  approved?: boolean;
  // Where the row came from and what it promises:
  //   "app"    — we generate the artwork (the historical behaviour)
  //   "manual" — named on Monday, supplied outside this system
  //   "info"   — named on Monday, physical packing instruction, no artwork
  // Absent ⇒ "app", so callers predating the Trims manifest (the layout
  // editor's preview) keep their exact behaviour.
  kind?: "app" | "manual" | "info";
  // Monday's verbatim entry, when the row came from the Trims cell. Present
  // even when it equals displayName, so the render can tell the two sources
  // apart without re-deriving it.
  sourceLabel?: string;
  // The document name(s) this Monday entry is answered by, when they differ
  // from the entry itself — printed as a second line so "Wash Care Label with
  // Oeko-tex Logo" and the file named "…Care Label.pdf" can be reconciled.
  suppliedAs?: string[];
  // Wording resolved from the row's trim CONCEPT (src/lib/trims/concept-copy.ts)
  // — a standing note about what this kind of document is. Shape inlined rather
  // than imported to keep this leaf import-free. ABSENT when the concept has
  // nothing to say, which is what keeps the fingerprint of an unaffected
  // manifest byte-identical to what it was before this field existed.
  copy?: { note?: string };
};

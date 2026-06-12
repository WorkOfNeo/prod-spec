// =====================================================
// Doc types — categorisation for outputs (picker grouping, JobAsset
// labelling, SharePoint metadata; no render behaviour hangs off them).
//
// The catalogue lives in the doc_types TABLE and is managed in the UI
// (Custom outputs → Document types card): operators add types and edit
// labels there, no migration needed. Server code loads it via
// loadDocTypes() in ./doc-types-db; client components receive entries/
// labels as props.
//
// This module is CLIENT-SAFE (no db import): the seed list mirrors the
// migration's six rows and doubles as the fallback while the doc_types
// migration hasn't been applied yet, and docTypeLabel() resolves labels
// with a title-case fallback for values missing from a provided map
// (runner-internal COVER/GENERAL_INFO framing pages, fresh values).
// =====================================================

export type DocTypeEntry = { value: string; label: string };

export const DEFAULT_DOC_TYPES: DocTypeEntry[] = [
  { value: "WASHCARE", label: "Wash care" },
  { value: "CARE_LABEL", label: "Care label" },
  { value: "STICKER", label: "Sticker" },
  { value: "HANGTAG", label: "Hang tag" },
  { value: "CARTON_MARKING", label: "Carton marking" },
  { value: "COLOUR_STICKER", label: "Colour sticker" },
];

const DEFAULT_LABELS: Record<string, string> = Object.fromEntries(
  DEFAULT_DOC_TYPES.map((t) => [t.value, t.label]),
);

// Human label for ANY docType value: the provided catalogue map first
// (DB labels, passed down from a server component), then the seed
// labels, then title-cased SCREAMING_SNAKE (COVER → "Cover", and brand-
// new values keep working everywhere before a label reaches a given
// view).
export function docTypeLabel(docType: string, labels?: Record<string, string>): string {
  return (
    labels?.[docType] ??
    DEFAULT_LABELS[docType] ??
    docType
      .toLowerCase()
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

// Derive the immutable storage value from a human name typed in the UI:
// "Insert card" → "INSERT_CARD". Mirrors the API route's validation.
export function deriveDocTypeValue(label: string): string {
  return label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

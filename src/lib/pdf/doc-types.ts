import type { DocType } from "@/generated/prisma/enums";

// =====================================================
// THE doc-type catalogue — single source for every place a document
// type is picked or shown: the Output Builder type select + list
// column, the prod-spec output picker (labels, filter chips, sort),
// custom outputs grid badges, and asset display-name fallbacks.
//
// docType is categorisation + storage only (picker grouping, JobAsset
// labelling, SharePoint metadata) — no render behaviour hangs off it.
// It IS a Postgres enum though, so ADDING A TYPE is a small code+
// migration change, not a UI action:
//
//   1. prisma/schema.prisma — add the value to `enum DocType`.
//   2. prisma/migrations/<timestamp>_add_doctype_<x>/migration.sql —
//      one idempotent line:
//        ALTER TYPE "DocType" ADD VALUE IF NOT EXISTS 'MY_TYPE';
//      then `npx prisma generate`, and Niels runs `npm run db:deploy`.
//   3. Add the value + human label to ALL_DOC_TYPES / DOC_TYPE_LABELS
//      below. Every select, badge and filter picks it up from here.
//
// COVER and GENERAL_INFO exist in the enum but are deliberately NOT
// listed: they're runner-generated bundle framing pages, not pickable
// template variants. docTypeLabel() still prettifies them (and any
// future unlisted value) via the fallback.
// =====================================================

export const ALL_DOC_TYPES = [
  "WASHCARE",
  "CARE_LABEL",
  "STICKER",
  "HANGTAG",
  "CARTON_MARKING",
  "COLOUR_STICKER",
] as const satisfies readonly DocType[];

export const DOC_TYPE_LABELS: Record<(typeof ALL_DOC_TYPES)[number], string> = {
  WASHCARE: "Wash care",
  CARE_LABEL: "Care label",
  STICKER: "Sticker",
  HANGTAG: "Hang tag",
  CARTON_MARKING: "Carton marking",
  COLOUR_STICKER: "Colour sticker",
};

// Human label for ANY docType value — catalogue label when listed,
// title-cased SCREAMING_SNAKE otherwise (COVER → "Cover", and new enum
// values keep working before a label lands here).
export function docTypeLabel(docType: string): string {
  return (
    (DOC_TYPE_LABELS as Record<string, string>)[docType] ??
    docType
      .toLowerCase()
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

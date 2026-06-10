import type { DocType } from "@/generated/prisma/enums";
import type { ColumnMapping } from "@/lib/customers/config";
import type { StyleData } from "./types";
import { renderCareLabel01Html } from "./templates/care-label-01";
import { renderCareLabel02Html } from "./templates/care-label-02";
import { renderNettoWashCareLabelHtml } from "./templates/netto-dk-privatelabel/wash-care-label";
import { renderNettoInfoAreaHtml } from "./templates/netto-dk-privatelabel/info-area";
import {
  renderNettoCartonMarkingHtml,
  ORDER_NO_RULE,
} from "./templates/netto-dk-privatelabel/carton-marking";
import { ruleRequiredColumns } from "./spec-fields";
import { PRINT_SPEC_VARIANTS } from "./print-spec-variants";

// =====================================================
// Template variant registry — the catalogue admins pick from in the
// ProdSpec editor. Adding a new variant is a code addition: write a
// render function (or reuse one), add an entry to TEMPLATE_VARIANTS,
// done. The admin UI lists everything here automatically.
//
// Each variant has:
//   - `key` — stable, kebab-case identifier persisted on JobAsset rows
//     and inside ProdSpec.outputs. Never rename without a migration.
//   - `docType` — the abstract category (WASHCARE / STICKER / …). Used
//     for grouping in the UI and as a fallback for JobAsset.docType.
//   - `name` / `description` — human-readable for the picker.
//   - `defaultWidthMm`, `defaultHeightMm` — proposed dims; the admin
//     can override on the ProdSpec.
//   - `render(style, dims)` — the function the runner calls.
// =====================================================

export type OutputDims = {
  widthMm: number;
  heightMm: number;
};

export type TemplateVariant = {
  key: string;
  docType: DocType;
  name: string;
  description: string;
  defaultWidthMm: number;
  defaultHeightMm: number;
  // Resolved-spec fields this template needs to render meaningfully (keys of
  // ColumnMapping / STYLE_FIELD_LABELS). A style's overall required-field set
  // is the UNION of these across the outputs its ProdSpec will print.
  requiredFields: Array<keyof ColumnMapping>;
  // Optional dynamic readiness: given a resolver over the style's current
  // row values, return the EFFECTIVE required column keys. Used by variants
  // with declarative switch bindings, where only the taken branch's columns
  // are required (e.g. DDP carton markings need poNumber, not
  // customerOrderNo). When absent, `requiredFields` is the static gate.
  readiness?: (resolve: (field: keyof ColumnMapping) => string) => Array<keyof ColumnMapping>;
  render: (style: StyleData, dims: OutputDims) => Promise<string>;
  // Static-pdf passthrough (print specs with renderStrategy 'static-pdf'):
  // the artifact is these bytes VERBATIM — graphic-heavy artwork the app
  // must not redraw. Every artifact-emitting path (job runner, preview
  // route) MUST check this before calling `render`; when set, `render`
  // only produces the on-screen metadata card for /custom-outputs.
  staticPdf?: () => Promise<Buffer>;
};

export const TEMPLATE_VARIANTS: TemplateVariant[] = [
  {
    key: "care-label-01",
    docType: "CARE_LABEL",
    name: "Care Label 01 · Size barcode",
    description:
      "35×40 mm white satin label: ProdSpec logo + 'Size / Stl / Str' + size label + EAN-13 barcode. One page per size.",
    defaultWidthMm: 35,
    defaultHeightMm: 40,
    requiredFields: ["sizes", "ean13"],
    render: renderCareLabel01Html,
  },
  {
    key: "care-label-02",
    docType: "CARE_LABEL",
    name: "Care Label 02 · Long folded label (4 sheets)",
    description:
      "4-page PDF for a 35×90 mm folded label. S2 FRONT = composition + wash care symbols. S2 BACK = care instructions (en/da/de/fi/no/sv/nl). S3 FRONT = care continuation (fr/pl) + Made-in [country] multilingual + PO No. + Contrast brand block. S3 BACK = blank.",
    defaultWidthMm: 35,
    defaultHeightMm: 90,
    requiredFields: ["composition", "washCare", "sizes", "poNumber", "countryOfOrigin"],
    render: renderCareLabel02Html,
  },
  {
    key: "netto-dk-privatelabel-wash-care-label",
    docType: "CARE_LABEL",
    name: "Netto DK Private Label · Wash Care Label",
    description:
      "35×90 mm folded multi-sheet care label: composition + wash-care symbols, multilingual care instructions, Made-in [country], PO No., CONTRAST brand block, certificates/QR. Mirrors Care Label 02.",
    defaultWidthMm: 35,
    defaultHeightMm: 90,
    requiredFields: ["composition", "washCare", "sizes", "poNumber", "countryOfOrigin"],
    render: renderNettoWashCareLabelHtml,
  },
  {
    key: "netto-dk-privatelabel-info-area",
    docType: "WASHCARE",
    name: "Netto DK Private Label · Info Area",
    description:
      "Direct-print packaging block: composition + wash-care symbols + EAN-13 barcode. One page per size.",
    defaultWidthMm: 40,
    defaultHeightMm: 60,
    requiredFields: ["composition", "washCare", "sizes", "ean13"],
    render: renderNettoInfoAreaHtml,
  },
  {
    key: "netto-dk-privatelabel-carton-marking",
    docType: "CARTON_MARKING",
    name: "Netto DK Private Label · Carton Marking",
    description:
      "A6 master-carton label: customer + article + pcs/master + order no. (FOB = customer order, DDP = Contrast PO) + carton EAN as a Code128 (EAN128) barcode.",
    defaultWidthMm: 105,
    defaultHeightMm: 148,
    // Static gate: what the template reads unconditionally. The order
    // number is branch-dependent (FOB → customerOrderNo, else poNumber) —
    // handled by `readiness` below so a DDP row is never blocked on a
    // customer order number it legitimately doesn't have. deliveryTerm
    // itself is not required: empty means DDP, a valid state.
    requiredFields: ["cartonQty", "cartonEan", "description"],
    readiness: (resolve) => [
      "cartonQty",
      "cartonEan",
      "description",
      ...ruleRequiredColumns(ORDER_NO_RULE, resolve),
    ],
    render: renderNettoCartonMarkingHtml,
  },
  // Spec-driven variants — one per wired print spec file (src/print-specs/**),
  // rendered by per-family renderers. See src/lib/pdf/print-spec-variants.ts.
  ...PRINT_SPEC_VARIANTS,
];

export function getVariant(key: string): TemplateVariant | null {
  return TEMPLATE_VARIANTS.find((v) => v.key === key) ?? null;
}

// Union of the required fields across a set of variant keys — the basis for
// "what does this style need to print" (the enabled outputs of its ProdSpec).
export function requiredFieldsForVariants(keys: string[]): Array<keyof ColumnMapping> {
  const set = new Set<keyof ColumnMapping>();
  for (const k of keys) for (const f of getVariant(k)?.requiredFields ?? []) set.add(f);
  return [...set];
}

export function variantsByDocType(): Map<DocType, TemplateVariant[]> {
  const map = new Map<DocType, TemplateVariant[]>();
  for (const v of TEMPLATE_VARIANTS) {
    const arr = map.get(v.docType) ?? [];
    arr.push(v);
    map.set(v.docType, arr);
  }
  return map;
}

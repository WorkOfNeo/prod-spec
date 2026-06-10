import type { DocType } from "@/generated/prisma/enums";
import type { PrintSpec, PrintType, FieldKey } from "@/print-specs/shared/types";
import type { ColumnMapping } from "@/lib/customers/config";
import type { StyleData } from "./types";
import type { TemplateVariant, OutputDims } from "./template-registry";
import { escapeHtml } from "./templates/base";
import { makeCareLabelSquare3LabelRenderer } from "./templates/families/care-label-square-3label";
import { makeNettoCartonMarkingRenderer } from "./templates/families/carton-marking-netto-dk";
import { makeGenericSpecRenderer } from "./templates/families/spec-generic";
import { loadStaticPdf } from "./static-pdfs";
import { ALL_PRINT_SPECS } from "./print-spec-catalog";

// =====================================================
// Bridge: print spec files (src/print-specs/**) → template variants.
//
// One spec file = one catalogue variant = one PDF artifact.
//
//   • dynamic specs render through a family renderer — bespoke where one
//     exists (FAMILY_RENDERERS), the generic spec-driven renderer for
//     everything else. Upgrading a family to a bespoke renderer changes
//     nothing about variant keys, ProdSpec rows, or seeds.
//   • static-pdf specs become passthrough variants: the artifact is the
//     committed source artwork (assets/print-specs/), emitted verbatim by
//     the runner/preview; `render` only draws the on-screen catalogue card.
// =====================================================

type RenderFn = (style: StyleData, dims: OutputDims) => Promise<string>;

// Families with a bespoke renderer. Any dynamic spec whose family isn't
// listed here renders through the generic spec renderer.
const FAMILY_RENDERERS: Record<string, (spec: PrintSpec) => RenderFn> = {
  "care-label-square-3label": makeCareLabelSquare3LabelRenderer,
  "carton-marking-netto-dk": makeNettoCartonMarkingRenderer,
};

// The DocType enum predates the print-spec catalogue and only has six
// values; several spec print types have no exact match and map to their
// closest category. Revisit with a schema migration when finer grouping
// is needed in the UI.
const DOC_TYPE_BY_PRINT_TYPE: Record<PrintType, DocType> = {
  "wash-care-label": "WASHCARE",
  "care-label": "CARE_LABEL",
  "price-sticker": "STICKER",
  "price-tag": "STICKER",
  "polybag-sticker": "STICKER",
  "barcode-sticker": "STICKER",
  "tag-sticker": "STICKER",
  "hangtag-sticker": "STICKER",
  "info-area": "STICKER",
  neckprint: "STICKER",
  banderole: "STICKER",
  hangtag: "HANGTAG",
  "carton-marking": "CARTON_MARKING",
  "box-layout": "CARTON_MARKING",
};

const PRINT_TYPE_LABELS: Record<PrintType, string> = {
  "wash-care-label": "Wash care label",
  "care-label": "Care label",
  "price-sticker": "Price sticker",
  "price-tag": "Price tag",
  "polybag-sticker": "Polybag sticker",
  "barcode-sticker": "Barcode sticker",
  "tag-sticker": "Tag sticker",
  "hangtag-sticker": "Hangtag sticker",
  "info-area": "Info area",
  neckprint: "Neckprint",
  banderole: "Banderole",
  hangtag: "Hangtag",
  "carton-marking": "Carton marking",
  "box-layout": "Box layout",
};

// Which mapped Monday column feeds each spec field. `null` = the field
// needs no column (static brand content, or derived data — care
// instructions compose from wash symbols + the DB care-label lines).
const COLUMN_BY_FIELD: Record<FieldKey, keyof ColumnMapping | null> = {
  composition: "composition",
  composition2: "composition2",
  careInstructions: "washCare",
  washCareSymbols: "washCare",
  countryOfOrigin: "countryOfOrigin",
  sizes: "sizes",
  sizeRange: "sizes",
  ean13: "ean13",
  ean128: "cartonEan",
  customerItemNo: "customerItemNo",
  customerOrderNumber: "customerOrderNo",
  poNumber: "poNumber",
  styleNumber: "styleNumber",
  description: "description",
  qtyPerCarton: "cartonQty",
  retailPrice: "price",
  campaignWeek: "campaignWeek",
  lotNo: "lot",
  batchNo: "batchNo",
  // The customer's article number under a different label (Rema layouts).
  articleNo: "customerItemNo",
  prodNumber: "prodNumber",
  supplierAddress: null,
  oekoTexLogo: null,
  // Filled from the Customer record by the runner (StyleData.customerName),
  // not from a mapped board column.
  customerName: null,
};

function requiredFieldsFor(spec: PrintSpec): Array<keyof ColumnMapping> {
  const out: Array<keyof ColumnMapping> = [];
  for (const part of spec.parts ?? []) {
    for (const field of part.fields) {
      if (!field.required) continue;
      const column = COLUMN_BY_FIELD[field.key];
      if (column && !out.includes(column)) out.push(column);
    }
  }
  return out;
}

// Catalogue card dims: spec-level dimensions when present, otherwise the
// largest part. Size-changeable specs (all parts 0×0) fall back to a
// 40×60 mm working size — for those, the admin-set output dims are the
// real page size at render time.
function defaultDims(spec: PrintSpec): { widthMm: number; heightMm: number } {
  if (spec.dimensions && spec.dimensions.widthMm > 0 && spec.dimensions.heightMm > 0) {
    return spec.dimensions;
  }
  let best = { widthMm: 0, heightMm: 0 };
  let bestArea = 0;
  for (const part of spec.parts ?? []) {
    const area = part.dimensions.widthMm * part.dimensions.heightMm;
    if (area > bestArea) {
      bestArea = area;
      best = part.dimensions;
    }
  }
  return bestArea > 0 ? best : { widthMm: 40, heightMm: 60 };
}

function describe(spec: PrintSpec): string {
  const firstSentence = (spec.notes ?? "").split(/(?<=\.)\s+/)[0] ?? "";
  const suffix = spec.dimensionsVerified
    ? ""
    : " Dimensions unverified — see src/print-specs/REVIEW.md.";
  return `Spec-driven (${spec.id}). ${firstSentence}${suffix}`.trim();
}

// On-screen catalogue card for a static passthrough variant. Never an
// artifact — the runner and preview route branch on `staticPdf` first.
function staticPreviewCard(spec: PrintSpec): string {
  const dims = spec.dimensions
    ? `${spec.dimensions.widthMm} × ${spec.dimensions.heightMm} mm`
    : "size per PO / see artwork";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: -apple-system, Helvetica, Arial, sans-serif; }
    .card { padding: 12px; border: 1px dashed #999; border-radius: 6px; margin: 8px; }
    .tag { font-size: 10px; letter-spacing: 0.08em; color: #666; text-transform: uppercase; }
    .name { font-size: 13px; font-weight: 600; margin: 4px 0; }
    .meta { font-size: 11px; color: #444; line-height: 1.5; }
  </style></head><body><div class="card">
    <div class="tag">Static artwork passthrough</div>
    <div class="name">${escapeHtml(spec.customer)} · ${escapeHtml(spec.businessArea)} — ${escapeHtml(PRINT_TYPE_LABELS[spec.printType])}</div>
    <div class="meta">
      Print size: ${escapeHtml(dims)}<br/>
      The output is the source artwork PDF, emitted verbatim:<br/>
      <code>${escapeHtml(spec.sourcePdf)}</code><br/>
      Open the PDF preview to see the actual artifact.
    </div>
  </div></body></html>`;
}

function toVariant(spec: PrintSpec): TemplateVariant {
  const dims = defaultDims(spec);
  const base = {
    key: spec.id,
    docType: DOC_TYPE_BY_PRINT_TYPE[spec.printType],
    name: `${spec.customer} · ${spec.businessArea} · ${PRINT_TYPE_LABELS[spec.printType]}`,
    defaultWidthMm: dims.widthMm,
    defaultHeightMm: dims.heightMm,
  };

  if (spec.renderStrategy === "static-pdf") {
    return {
      ...base,
      description: `${describe(spec)} Static artwork passthrough — the job asset is the source PDF, byte for byte.`,
      requiredFields: [],
      render: async () => staticPreviewCard(spec),
      staticPdf: () => loadStaticPdf(spec.sourcePdf),
    };
  }

  const factory = FAMILY_RENDERERS[spec.layoutFamily ?? ""] ?? makeGenericSpecRenderer;
  return {
    ...base,
    description: describe(spec),
    requiredFields: requiredFieldsFor(spec),
    render: factory(spec),
  };
}

// Variants for the full print-spec catalogue (84 = 54 dynamic + 30 static).
// Spread into TEMPLATE_VARIANTS by the registry.
export const PRINT_SPEC_VARIANTS: TemplateVariant[] = ALL_PRINT_SPECS.map(toVariant);

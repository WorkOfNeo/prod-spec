import type { ColumnMapping } from "@/lib/customers/config";
import type { StyleData } from "./types";
import type { PinnableField } from "./pins-meta";
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
  docType: string;
  name: string;
  description: string;
  defaultWidthMm: number;
  defaultHeightMm: number;
  // Published content version for Output Builder layouts (OutputLayout.version,
  // bumped on every publish). Folded into outputConfigKey so a re-published
  // layout edit marks the output "changed". Undefined for coded variants,
  // whose content is versioned only by a code deploy.
  contentVersion?: number;
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
  // The PINNABLE fields this output actually prints — the set the review-time
  // field editor offers as pre-filled, editable inputs. For Output Builder
  // layouts it's derived from the tokens in the definition; coded variants
  // leave it undefined and callers fall back to `requiredFields` ∩ pinnable.
  editableFields?: PinnableField[];
  render: (style: StyleData, dims: OutputDims) => Promise<string>;
  // True for "info area" Output Builder layouts (OutputLayout.isInfoArea):
  // the print size is switchable per style, so `dims` (the resolved
  // InfoAreaSize / custom size) OVERRIDES the layout's page dimensions at
  // render time. Coded variants leave it undefined (= fixed dims as before).
  isInfoArea?: boolean;
  // Optional custom output file name (Output Builder layouts carry a
  // fileName expression in their settings). Returns "<name>.pdf" or null
  // to use the runner's default.
  fileNameFor?: (style: StyleData) => string | null;
  // Eligible for MANUAL "X of Y" carton-numbered prints — Output Builder
  // layouts whose settings.cartonNumbering is on. Surfaces the Style-page
  // "Carton numbers…" action; coded variants leave it undefined (= false).
  cartonNumbering?: boolean;
  // Eligible for "Custom Carton Marking" (multi-style box) — Output Builder
  // layouts whose settings.multipleStyles is on. Surfaces the carton
  // dialog's sibling multiselect; independent of cartonNumbering.
  multipleStyles?: boolean;
  // Does this output bind a PER-ROW carton EAN when it renders? True for the
  // repeats that rebind {{cartonEan}} per repetition row (repeatBy "ean" /
  // "cartonEan" — see repetitionStyles in output-layouts/render.ts). False (or
  // undefined) means the layout prints ONE carton for the whole style, taken
  // from the style-level Style.cartonEan.
  //
  // Readiness needs the distinction: a style whose Monday/PO carton column
  // lists per-size cartons but carries no "Assort - <EAN>" line has per-row
  // cartons and a NULL Style.cartonEan. That satisfies a per-carton repeat, but
  // a non-repeating layout would render a BLANK barcode — so the per-size rows
  // must not count as "cartonEan is filled" for it.
  perRowCartonEan?: boolean;
  // Optional multi-document rendering (Output Builder repeat-per-EAN):
  // one PDF per returned doc, persisted as JobAssets with variantKey
  // "<key>#<suffix>". fileName null → runner default + suffix. `dims` is the
  // resolved output size (info-area size override flows through here too).
  // `perDocOverrides` (Output Builder only): per-document field overrides keyed
  // by the doc's `suffix`, layered on top of the (already whole-output-
  // overridden) style so a reviewer can correct a value on ONE PDF of a
  // repeat-per-EAN output. Absent / no match ⇒ the row renders unchanged.
  renderMany?: (
    style: StyleData,
    dims: OutputDims,
    perDocOverrides?: ReadonlyMap<string, Record<string, string>>,
  ) => Promise<Array<{ suffix: string; fileName: string | null; html: string }>>;
  // The per-document styles a multi-doc (repeat-per-EAN) output would render —
  // one entry per PDF, its `suffix` matching renderMany/filesPreview and the
  // per-row `style` (colour / carton EAN narrowed to that PDF). Lets the
  // review-time editor pre-fill each PDF card with ITS values. Undefined for
  // single-document outputs.
  docStyles?: (style: StyleData) => Array<{ suffix: string; style: StyleData }>;
  // Optional pre-run files preview: the per-file plan (suffix + custom
  // name, null = runner default) the NEXT run would emit for a style,
  // WITHOUT rendering anything. Output Builder layouts implement it
  // repeat/split-aware; variants without it emit exactly one file.
  filesPreview?: (style: StyleData) => Array<{ suffix: string | null; fileName: string | null }>;
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

// =====================================================
// Dynamic variants — operator-built Output Builder layouts, registered
// at runtime under `layout:<id>` keys. This module stays client-safe
// (no db import): the map is populated by the SERVER-ONLY loader in
// src/lib/output-layouts/variants.ts (ensureLayoutVariantsLoaded), which
// every async entry point that can meet a layout key awaits first.
// Sync lookups below those entry points then resolve from the map.
// =====================================================

const DYNAMIC_VARIANTS = new Map<string, TemplateVariant>();

export function setDynamicVariants(variants: TemplateVariant[]): void {
  DYNAMIC_VARIANTS.clear();
  for (const v of variants) DYNAMIC_VARIANTS.set(v.key, v);
}

export function dynamicVariants(): TemplateVariant[] {
  return [...DYNAMIC_VARIANTS.values()];
}

// Full catalogue: code-registered variants + loaded dynamic layouts.
export function allVariants(): TemplateVariant[] {
  return [...TEMPLATE_VARIANTS, ...DYNAMIC_VARIANTS.values()];
}

export function getVariant(key: string): TemplateVariant | null {
  return TEMPLATE_VARIANTS.find((v) => v.key === key) ?? DYNAMIC_VARIANTS.get(key) ?? null;
}

// Default artifact file name — "<style-slug>-<variant-key>.pdf", with
// "-<suffix>" before the extension for multi-document files. ONE source
// of truth shared by the runner (actual asset naming) and the style
// page's pre-run files preview, so the preview can never drift from
// what a job really emits.
export function defaultArtifactFileName(
  variant: TemplateVariant,
  styleNumber: string,
  suffix?: string | null,
): string {
  const slug = styleNumber.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  return `${slug}-${variant.key}${suffix ? `-${suffix}` : ""}.pdf`;
}

// Union of the required fields across a set of variant keys — the basis for
// "what does this style need to print" (the enabled outputs of its ProdSpec).
export function requiredFieldsForVariants(keys: string[]): Array<keyof ColumnMapping> {
  const set = new Set<keyof ColumnMapping>();
  for (const k of keys) for (const f of getVariant(k)?.requiredFields ?? []) set.add(f);
  return [...set];
}

export function variantsByDocType(): Map<string, TemplateVariant[]> {
  const map = new Map<string, TemplateVariant[]>();
  for (const v of TEMPLATE_VARIANTS) {
    const arr = map.get(v.docType) ?? [];
    arr.push(v);
    map.set(v.docType, arr);
  }
  return map;
}

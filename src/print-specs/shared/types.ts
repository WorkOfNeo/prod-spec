// Shared types for print specs — single shared module (see AGENT BRIEF).
// Every spec file under src/print-specs/<customer>/<area>/ is fully
// self-contained and imports only from this file.

export type RenderStrategy = 'dynamic' | 'static-pdf';

export type Lang =
  | 'EN' | 'DA' | 'DE' | 'FI' | 'NO' | 'SV' | 'NL' | 'FR' | 'PL' | 'ET'   // Nordic sets
  | 'CS' | 'HR' | 'RO' | 'SK' | 'BG';                                     // Kaufland set

export type PrintType =
  | 'wash-care-label' | 'care-label' | 'price-sticker' | 'price-tag'
  | 'polybag-sticker' | 'barcode-sticker' | 'tag-sticker' | 'hangtag-sticker'
  | 'info-area' | 'neckprint' | 'banderole' | 'hangtag'
  | 'carton-marking' | 'box-layout';

export type FieldKey =
  | 'composition' | 'composition2' | 'careInstructions' | 'washCareSymbols'
  | 'countryOfOrigin' | 'sizes' | 'sizeRange' | 'ean13' | 'ean128'
  | 'customerItemNo' | 'customerOrderNumber' | 'poNumber' | 'styleNumber'
  | 'description' | 'qtyPerCarton' | 'retailPrice' | 'campaignWeek'
  | 'lotNo' | 'batchNo' | 'articleNo' | 'prodNumber' | 'supplierAddress'
  | 'oekoTexLogo' | 'customerName' | 'deliveryTerm';

export interface Dimensions { widthMm: number; heightMm: number; }

// Declarative value binding for a field. Deliberately tiny — const / field /
// switch only, no expressions and no scripting. Anything richer graduates to
// a bespoke family renderer instead of growing a DSL here.
//
//   { const: 'Netto A/S' }                       → ALWAYS this string
//   { field: 'poNumber' }                        → read another variable
//   { switch: 'deliveryTerm',                    → column-driven branch:
//     cases: { FOB: { field: 'customerOrderNumber' } },
//     default: { field: 'poNumber' } }             "if it says FOB print the
//                                                    customer order no, else
//                                                    the Contrast PO"
//
// `switch` matching is a case-insensitive "contains" on the resolved text
// (so "FOB Shanghai" matches the FOB case). Readiness follows the TAKEN
// branch: only the columns that branch reads are required.
export type ValueRule =
  | { const: string }
  | { field: FieldKey }
  | { switch: FieldKey; cases: Record<string, ValueRule>; default?: ValueRule };

export interface FieldSpec {
  key: FieldKey;
  languages?: Lang[];          // only for translated text fields
  required: boolean;
  source: 'po' | 'article' | 'customer-master' | 'manual';
  notes?: string;
  // Optional declarative binding for this field's printed value. When set,
  // renderers resolve the rule (src/lib/pdf/spec-fields.ts) instead of the
  // field's default column variable.
  value?: ValueRule;
}

export interface PartSpec {                // a sheet/side of a multi-part label
  id: string;                              // e.g. 'sheet1', 'sheet2-front'
  dimensions: Dimensions;
  fields: FieldSpec[];
}

export interface PrintSpec {
  id: string;                              // kebab id, unique
  customer: string;
  businessArea: string;
  printType: PrintType;
  renderStrategy: RenderStrategy;
  sourcePdf: string;                       // filename in Renamed PDFs/
  layoutFamily?: string;                   // family id (metadata only — specs are self-contained)
  parts?: PartSpec[];                      // dynamic only
  dimensions?: Dimensions;                 // static-pdf: overall print size if known
  dimensionsVerified: boolean;             // false ⇒ needs human check
  currency?: 'DKK' | 'SEK' | 'NOK' | 'EUR';
  notes?: string;
}

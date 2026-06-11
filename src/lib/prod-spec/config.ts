import { z } from "zod";
import type { DocType } from "@/generated/prisma/enums";
import {
  ColumnMappingSchema,
  RequiredFieldSchema,
  type ColumnMapping,
  type RequiredField,
} from "@/lib/customers/config";
import { TEMPLATE_VARIANTS, getVariant, type TemplateVariant } from "@/lib/pdf/template-registry";

// =====================================================
// ProdSpec — config bundle for one (Customer × BusinessArea) pair.
//
// `outputs` is now an array of *selected variants* — each entry names
// a template variant from the registry plus the mm dims (overriding
// the variant's defaults). The admin picks variants from the catalogue
// and stores their picks here. The runner iterates the array, looks up
// each variant in the registry, and calls its renderer.
//
// Legacy shape (object keyed by DocType) is still parsed and silently
// upgraded — see `parseProdSpecOutputs` below.
// =====================================================

// Pickable doc types + labels live in the doc-type catalogue; re-export
// keeps the existing import sites (zod enum in the layout PATCH route).
export { ALL_DOC_TYPES } from "@/lib/pdf/doc-types";

export const ProdSpecOutputSchema = z.object({
  variantKey: z.string().min(1),
  widthMm: z.number().positive().max(1000),
  heightMm: z.number().positive().max(1000),
  enabled: z.boolean().default(true),
  // Per-output field pins ("customerName is ALWAYS 'Netto A/S'") — set in
  // the ProdSpec editor, applied on top of everything at render time and
  // counted as satisfied by readiness. Keys are validated/filtered against
  // the pinnable vocabulary in src/lib/pdf/pins.ts at the point of use, so
  // a stale key never breaks parsing.
  fieldOverrides: z.record(z.string().min(1), z.string()).optional(),
  // Carton barcode preference — how the carton EAN prints on
  // CARTON_MARKING outputs (the coded carton-marking templates and Output
  // Builder layouts alike; ignored by other doc types). Absent type =
  // EAN-128 (Code 128 bars with the number printed beneath — the historic
  // behaviour); "ean13" = true EAN-13 with the digits inside the symbol.
  // heightMm overrides the renderer's default bar height for the carton
  // barcode only. Applied via applyCartonBarcodePrefs (src/lib/pdf/pins.ts).
  cartonBarcodeType: z.enum(["ean128", "ean13"]).optional(),
  cartonBarcodeHeightMm: z.number().min(4).max(60).optional(),
});
export type ProdSpecOutput = z.infer<typeof ProdSpecOutputSchema>;

export const ProdSpecOutputsSchema = z.array(ProdSpecOutputSchema);
export type ProdSpecOutputs = ProdSpecOutput[];

export const ProdSpecConfigInputSchema = z.object({
  outputs: ProdSpecOutputsSchema.default([]),
  columnMapping: ColumnMappingSchema.default({}),
  requiredFields: z.array(RequiredFieldSchema).default([]),
  autoGenerateThresholdPct: z.number().int().min(0).max(100).default(100),
});
export type ProdSpecConfigInput = z.infer<typeof ProdSpecConfigInputSchema>;

// Default selection for a fresh ProdSpec — empty.
// Each operator picks variants explicitly in the editor; we don't ship a
// pre-populated default because (a) the catalogue is going to keep growing
// and the chance that "all variants" is the right set goes to zero, and
// (b) auto-attaching variants to every ProdSpec makes "what does this
// ProdSpec produce?" surprising on first glance. Empty = honest.
export const DEFAULT_OUTPUTS: ProdSpecOutput[] = [];

export function parseProdSpecOutputs(raw: unknown): ProdSpecOutputs {
  // New array shape — preferred.
  if (Array.isArray(raw)) {
    return ProdSpecOutputsSchema.parse(raw);
  }
  // Legacy object shape: `{ WASHCARE: { enabled, widthMm, heightMm }, … }`.
  // Convert each entry to the new array form, defaulting variantKey to the
  // `*-standard` variant we registered above. Rows not touched here keep
  // their legacy JSON in the DB and migrate-on-write.
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([docType, val]) => {
        if (!val || typeof val !== "object") return null;
        const v = val as { enabled?: boolean; widthMm?: number; heightMm?: number };
        const variant = TEMPLATE_VARIANTS.find(
          (t) => t.docType === (docType as DocType),
        );
        if (!variant) return null;
        return {
          variantKey: variant.key,
          widthMm: typeof v.widthMm === "number" && v.widthMm > 0 ? v.widthMm : variant.defaultWidthMm,
          heightMm: typeof v.heightMm === "number" && v.heightMm > 0 ? v.heightMm : variant.defaultHeightMm,
          enabled: v.enabled !== false,
        } satisfies ProdSpecOutput;
      })
      .filter((x): x is ProdSpecOutput => x !== null);
  }
  return [];
}

export function parseProdSpecColumnMapping(raw: unknown): ColumnMapping {
  return ColumnMappingSchema.parse(raw ?? {});
}

// =====================================================
// Bundle framing page settings — print tuning for the cover page and the
// general information page, stored per ProdSpec in
// `ProdSpec.bundlePageSettings` as { cover: {...}, generalInfo: {...} }.
// Margins are mm from the page edge to the content (real @page margins,
// applied to every sheet of a multi-page document). Defaults mirror the
// values that used to be hard-coded in src/lib/pdf/bundle-pages.ts.
// =====================================================

export const PageSettingsSchema = z.object({
  marginTopMm: z.number().min(0).max(80).default(18),
  marginRightMm: z.number().min(0).max(80).default(18),
  marginBottomMm: z.number().min(0).max(80).default(22),
  marginLeftMm: z.number().min(0).max(80).default(18),
  baseFontPt: z.number().min(6).max(24).default(10),
  lineHeight: z.number().min(1).max(2.5).default(1.55),
  showFooter: z.boolean().default(true),
});
export type PageSettings = z.infer<typeof PageSettingsSchema>;

export const DEFAULT_PAGE_SETTINGS: PageSettings = PageSettingsSchema.parse({});

export const BundlePageSettingsSchema = z.object({
  cover: PageSettingsSchema.default(DEFAULT_PAGE_SETTINGS),
  generalInfo: PageSettingsSchema.default(DEFAULT_PAGE_SETTINGS),
});
export type BundlePageSettings = z.infer<typeof BundlePageSettingsSchema>;

// Defensive: malformed JSON (or partial objects from older saves) falls
// back to defaults rather than breaking render/editor paths.
export function parseBundlePageSettings(raw: unknown): BundlePageSettings {
  const parsed = BundlePageSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : BundlePageSettingsSchema.parse({});
}

export function parseProdSpecRequiredFields(raw: unknown): RequiredField[] {
  return z.array(RequiredFieldSchema).parse(raw ?? []);
}

// Coerce ProdSpec.outputLanguages JSON into a clean array of lowercase
// language codes (e.g. ["en","da","de"]). Drops non-strings / blanks and
// dedupes while preserving order. Empty array ⇒ templates use their
// built-in default language set (see src/lib/pdf/output-langs.ts).
export function parseProdSpecLanguages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const code = v.trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

// Resolve an output entry to its registered variant — code-registered
// AND dynamic (Output Builder layouts, `layout:<id>` keys; loaded into
// the registry by ensureLayoutVariantsLoaded). Returns null if the
// variantKey is stale (variant removed from code / layout deleted or
// unpublished) — the runner logs and skips in that case.
export function resolveOutputVariant(output: ProdSpecOutput): TemplateVariant | null {
  return getVariant(output.variantKey);
}

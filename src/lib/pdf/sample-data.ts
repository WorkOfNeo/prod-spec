import type { StyleData } from "./types";
import { computeEan13Checksum } from "./barcode";

// =====================================================
// Sample StyleData for the Custom Outputs preview page.
//
// Every template variant in the registry is fed THIS object so the
// /custom-outputs gallery can show what each output looks like once the
// dynamic fields are populated — without needing a real Style/Job in the
// database. The values are deliberately recognisable ("Sample Customer",
// "Cotton Crew Tee") so it reads as a proof, not real production data,
// while still exercising every field a template might render.
//
// One size only: most templates emit one page per size, so a single size
// keeps each preview to one clean page. care-label-02 is inherently
// multi-page (a 4-sheet folded label) regardless.
// =====================================================

// Build a valid EAN-13 from a 12-digit prefix so the bwip-js path
// (care-label-01) accepts it instead of printing an "invalid" notice.
function ean13(prefix12: string): string {
  return prefix12 + computeEan13Checksum(prefix12);
}

// A tiny inline-SVG wordmark standing in for the per-ProdSpec branded
// logo (care-label-01 / care-label-02 render it in their header slot).
const SAMPLE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><rect width="120" height="32" rx="4" fill="#111"/><text x="60" y="21" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#fff" text-anchor="middle" letter-spacing="1.5">BRAND</text></svg>`;

export function buildSampleStyleData(): StyleData {
  return {
    styleName: "Cotton Crew Tee",
    styleNumber: "STY-10427",
    customerName: "Sample Customer",
    // PL (not LOVED) so the sticker shows its barcode layout — the common
    // case. The LOVED price-tag branch is noted in the variant description.
    businessArea: "PL",

    composition: [
      { language: "en", text: "100% Organic Cotton" },
      { language: "de", text: "100% Bio-Baumwolle" },
      { language: "da", text: "100% Økologisk Bomuld" },
      { language: "no", text: "100% Økologisk Bomull" },
      { language: "sv", text: "100% Ekologisk Bomull" },
      { language: "fi", text: "100% Luomupuuvilla" },
      { language: "nl", text: "100% Biologisch Katoen" },
      { language: "fr", text: "100% Coton Biologique" },
      { language: "pl", text: "100% Bawełna Organiczna" },
    ],

    productNameTranslations: [
      { language: "en", text: "Cotton Crew Tee" },
      { language: "de", text: "Baumwoll-Rundhalsshirt" },
    ],

    // Standard codes (see STANDARD_WASHCARE_SYMBOLS) — resolve to SVGs when
    // the catalogue is seeded; render as tagged placeholders otherwise.
    // Chosen from the seeded-with-artwork set so the preview shows five
    // real symbols on one row.
    washSymbols: ["wash30", "bleach_no", "tumble_no", "iron_medium", "dryclean_no"],

    sizes: [{ label: "M", ean13: ean13("570012345678") }],

    carton: {
      klNumber: "KL-8842",
      supplierNumber: "SUP-512",
      lot: "LOT-2406",
      outerVE: 24,
      ean13: ean13("570087654321"),
    },

    colour: { name: "Navy Blue", code: "NVY-300" },
    price: { amount: 24.95, currency: "EUR" },

    supplierEmail: "supplier@example.com",
    poNumber: "C-PO62662",
    // Customer's own order number + delivery term — drive the Netto carton
    // marking's FOB/DDP order-number switch. "DDP" → prints the Contrast
    // poNumber above; set to "FOB" to preview the customerOrderNo branch.
    customerOrderNo: "NET-ORD-99812",
    deliveryTerm: "DDP",
    // A country the translations board covers, so the multilingual
    // "Made in …" run renders (Portugal isn't translated; China is).
    countryOfOrigin: "China",

    prodSpecLogoSvg: SAMPLE_LOGO_SVG,
    // No per-ProdSpec care-text override here on purpose — the care
    // instructions come from the DB-managed care labels (already joined
    // with " / "), so the preview shows the real, slash-separated content
    // a configured style would print.
    careInstructionsByLang: {},
    certificates: ["FSC", "OEKOTEX", "GOTS"],
    qrImageUrl: null,
  };
}

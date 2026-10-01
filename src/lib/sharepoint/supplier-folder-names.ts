import { sanitizeName } from "./supplier-folder";
import { coverColourLabel } from "@/lib/pdf/cover-file-name";

// =====================================================
// Single source of truth for supplier-folder NAMES, shared by the push
// (push-to-supplier.ts) and the legacy-folder cleanup so the two can never
// drift. The live layout is a per-PO parent folder with an "APPROVED LAYOUTS"
// subfolder holding the PDFs:
//
//   <supplier root>/
//     <PO> - <customer> - <supplier>/      ← supplierParentFolderName()
//       APPROVED LAYOUTS/                   ← APPROVED_LAYOUTS_SUBFOLDER
//         <style> - <colour>/               ← styleSubfolderName() (from the cutoff on)
//           <style-number>-<output>.pdf
//         <style-number>-<output>.pdf       ← the flat, pre-subfolder layout
//
// The parent is keyed on PO (not style), so every style under one PO shares it.
// Inside APPROVED LAYOUTS each style/colourway gets its own subfolder — but only
// for POs at or above the style-subfolder cutoff (styleSubfolderApplies), or a
// style an operator moved by hand. Older POs keep the flat layout the supplier
// already has; nothing is moved unless someone asks for it.
//
// Two earlier, now-WRONG shapes are reconstructed here purely so the cleanup
// script can find and delete them:
//   • legacyStyleCustomerFolderName — "<style> – <customer>" (pre-rename push).
//   • flatApprovedLayoutsFolderName — "<PO> - <customer> - <supplier> - APPROVED
//     LAYOUTS" as a SINGLE folder (the first rename, before APPROVED LAYOUTS was
//     split into a subfolder).
// =====================================================

export const APPROVED_LAYOUTS_SUBFOLDER = "APPROVED LAYOUTS";

// A style/colourway's own folder inside APPROVED LAYOUTS: "<style> - <colour>",
// e.g. "AB10001 - Navy". The colour is resolved exactly as the cover's file
// name resolves it (colour name first, then the "*"-stripped colour code), so
// the folder and the cover inside it can never name the colourway differently.
// No colour at all → the style number alone.
export function styleSubfolderName(input: {
  styleNumber: string;
  colour?: { name?: string | null; code?: string | null } | null;
}): string {
  const styleNumber = input.styleNumber.trim();
  const colour = coverColourLabel(input.colour);
  // A colour of only punctuation ("-", "*") carries no information — and after
  // sanitising could leave a dangling " - " — so treat it as no colour.
  const hasColour = /[\p{L}\p{N}]/u.test(colour);
  return sanitizeName(hasColour ? `${styleNumber} - ${colour}` : styleNumber);
}

// Does a style that has NOT been placed in a subfolder yet get one on its next
// upload? Forward-only, keyed on the PO like every other delivery cutoff:
//   • cutoff unset ⇒ never (the flat layout stays; setting the cutoff is the opt-in).
//   • poSeq null ⇒ never — a PO that can't be placed on the timeline can't be
//     said to be "from the cutoff on".
// Gating on the PO (not the style) keeps every style on one order on the same
// layout, so a PO folder is never half flat and half nested by accident.
export function styleSubfolderApplies(poSeq: number | null | undefined, minPo: number | null): boolean {
  if (minPo === null) return false;
  if (poSeq == null) return false;
  return poSeq >= minPo;
}

export type SupplierFolderNameInput = {
  poNumber: string | null;
  styleName: string;
  customerName: string;
  supplierName: string;
};

// The per-PO parent folder: "<PO> - <customer> - <supplier>". Falls back to the
// style number when the style has no PO (nothing to group on).
export function supplierParentFolderName(input: SupplierFolderNameInput): string {
  return sanitizeName(
    `${input.poNumber?.trim() || input.styleName} - ${input.customerName} - ${input.supplierName}`,
  );
}

// WRONG shape #1 (pre-rename): "<style> – <customer>" (en-dash). For cleanup only.
export function legacyStyleCustomerFolderName(styleName: string, customerName: string): string {
  return sanitizeName(`${styleName} – ${customerName}`);
}

// WRONG shape #2 (first rename, PR #190): the whole "<PO> - <customer> -
// <supplier> - APPROVED LAYOUTS" as a single folder. For cleanup only.
export function flatApprovedLayoutsFolderName(input: SupplierFolderNameInput): string {
  return sanitizeName(
    `${input.poNumber?.trim() || input.styleName} - ${input.customerName} - ${input.supplierName} - APPROVED LAYOUTS`,
  );
}

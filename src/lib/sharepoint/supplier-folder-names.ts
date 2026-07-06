import { sanitizeName } from "./supplier-folder";

// =====================================================
// Single source of truth for supplier-folder NAMES, shared by the push
// (push-to-supplier.ts) and the legacy-folder cleanup so the two can never
// drift. The live layout is a per-PO parent folder with an "APPROVED LAYOUTS"
// subfolder holding the PDFs:
//
//   <supplier root>/
//     <PO> - <customer> - <supplier>/      ← supplierParentFolderName()
//       APPROVED LAYOUTS/                   ← APPROVED_LAYOUTS_SUBFOLDER
//         <style-number>-<output>.pdf
//
// The parent is keyed on PO (not style), so every style under one PO shares it.
//
// Two earlier, now-WRONG shapes are reconstructed here purely so the cleanup
// script can find and delete them:
//   • legacyStyleCustomerFolderName — "<style> – <customer>" (pre-rename push).
//   • flatApprovedLayoutsFolderName — "<PO> - <customer> - <supplier> - APPROVED
//     LAYOUTS" as a SINGLE folder (the first rename, before APPROVED LAYOUTS was
//     split into a subfolder).
// =====================================================

export const APPROVED_LAYOUTS_SUBFOLDER = "APPROVED LAYOUTS";

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

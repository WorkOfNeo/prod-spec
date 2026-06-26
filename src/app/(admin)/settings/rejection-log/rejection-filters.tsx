// Display helper for the rejection log's "Output type" facet.

// "CARTON_MARKING" → "Carton marking" for the Output-type dropdown.
export function outputTypeLabel(docType: string): string {
  return docType
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

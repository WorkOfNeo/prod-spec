import type { StyleEanStatus } from "@/generated/prisma/enums";

// Shared, UI-facing shape for a style's resolved EANs. Type-only module so it
// can be imported by both server code (runner, route, page) and the client
// table without pulling server deps into the client bundle. Everything speaks
// the persisted StyleEanStatus enum so the badge vocabulary is consistent
// whether the data came from the DB or a fresh re-resolve.
export type EanSize = {
  size: string;
  ean13: string | null;
  variantLabel: string | null;
};

export type EanDiagnostics = {
  poNumber: string | null;
  poFileName: string | null;
  poFileId: string | null;
  /** How many PO PDFs matched the search. */
  candidateCount: number;
  /** Matching PDFs, best-first, with their score + SharePoint link. */
  candidates: Array<{ name: string; score: number; webUrl: string | null }>;
  queriesTried: string[];
  /** Direct SharePoint link to the chosen PO PDF — open it to verify. */
  poFileWebUrl: string | null;
  /** The supplier's SharePoint folder URL (Suppliers board), if linked. */
  supplierFolderUrl: string | null;
  /** Did the parser locate a "Barcodes" page in the chosen PDF? */
  barcodePageFound: boolean;
  pdfPageCount: number;
  pdfTextLength: number;
  /** Distinct 13-digit tokens anywhere in the PDF — a file-level "are there
   *  any barcodes at all" signal, independent of our page parser. */
  ean13TokensInFullText: number;
  parsedItemCount: number;
  parsedVariantCount: number;
  matchedByCustomerItemNo: boolean;
  customerItemNoOnStyle: string | null;
  styleSizes: string[];
  /** First ~600 chars of the Barcodes page (or whole doc) for eyeballing. */
  textSnippet: string;
};

export type EanView = {
  status: StyleEanStatus;
  message?: string;
  poFileName: string | null;
  sizeEans: EanSize[];
  cartonEan: string | null;
  /** Present after a live resolve (not persisted) — lets the UI/API show
   *  exactly which file was read and whether it contained barcodes. */
  diagnostics?: EanDiagnostics;
};

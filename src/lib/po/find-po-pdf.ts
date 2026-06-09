import {
  searchSharedFolder,
  searchSuppliersDrive,
  type SharedDriveItem,
} from "@/lib/sharepoint/shares";

// Finds the PO PDF for a PO number. PO numbers are unique, so the most
// reliable approach is a recursive search of the central "Suppliers" drive
// (which contains every supplier's folder) — this avoids depending on each
// supplier's folder URL being clean. Naming varies across suppliers
// ("Purchase Order C-PO61712.pdf", "PO 62486.pdf", "62486 - Barcode …"),
// so we filter to PDFs that reference the PO and rank them.

function relevantPdfs(candidates: SharedDriveItem[], poNumber: string): SharedDriveItem[] {
  const digits = poNumber.replace(/\D/g, "");
  const po = poNumber.toLowerCase();
  return candidates.filter(
    (r) =>
      /\.pdf$/i.test(r.name) &&
      (r.name.toLowerCase().includes(po) || (digits.length >= 4 && r.name.includes(digits))),
  );
}

// Filename-based ranking. The canonical "Purchase Order C-PO<n>.pdf" wins,
// but note: a dedicated "...Barcode..." sibling sometimes carries the EAN
// page instead. findPoPdfDetailed returns the full ranked list so we can
// spot that case rather than silently trust the top pick.
function scoreName(name: string, poNumber: string): number {
  const n = name.toLowerCase();
  const po = poNumber.toLowerCase();
  let s = 0;
  if (/purchase order/.test(n)) s += 100; // canonical PO PDF
  if (n.includes(po)) s += 50; // full "c-po61712"
  if (/\bpo\b/.test(n)) s += 10; // "PO 62486"
  if (/barcode/.test(n)) s += 5; // dedicated barcode doc
  return s - n.length * 0.01; // prefer concise canonical names
}

function pickBest(pdfs: SharedDriveItem[], poNumber: string): SharedDriveItem | null {
  if (pdfs.length === 0) return null;
  return [...pdfs].sort((a, b) => scoreName(b.name, poNumber) - scoreName(a.name, poNumber))[0];
}

export type PoPdfCandidate = { name: string; score: number; id: string; webUrl: string | null };

export type PoPdfSearch = {
  chosen: SharedDriveItem | null;
  /** Every relevant PDF, best-first, with its score — for verification. */
  candidates: PoPdfCandidate[];
  /** The Suppliers-drive queries we issued (PO string, then digits). */
  queriesTried: string[];
};

// Primary: search the central Suppliers drive by the unique PO number, and
// return the chosen PDF PLUS the full ranked candidate list, so callers can
// log "which file did we pick, and what else matched" to confirm correctness.
export async function findPoPdfDetailed(poNumber: string): Promise<PoPdfSearch> {
  const digits = poNumber.replace(/\D/g, "");
  const queriesTried: string[] = [poNumber];
  let pdfs = relevantPdfs(await searchSuppliersDrive(poNumber), poNumber);
  if (pdfs.length === 0 && digits) {
    queriesTried.push(digits);
    pdfs = relevantPdfs(await searchSuppliersDrive(digits), poNumber);
  }
  const ranked = [...pdfs].sort((a, b) => scoreName(b.name, poNumber) - scoreName(a.name, poNumber));
  return {
    chosen: ranked[0] ?? null,
    candidates: ranked.map((p) => ({
      name: p.name,
      score: Math.round(scoreName(p.name, poNumber) * 100) / 100,
      id: p.id,
      webUrl: p.webUrl ?? null,
    })),
    queriesTried,
  };
}

// Thin wrapper — just the chosen PDF.
export async function findPoPdf(poNumber: string): Promise<SharedDriveItem | null> {
  return (await findPoPdfDetailed(poNumber)).chosen;
}

// Folder-scoped variant — for when a specific supplier folder URL is known
// (a sharing link or a path URL; both resolve via Graph /shares).
export async function findPoPdfInFolder(
  folderUrl: string,
  poNumber: string,
): Promise<SharedDriveItem | null> {
  const digits = poNumber.replace(/\D/g, "");
  let pdfs = relevantPdfs(await searchSharedFolder(folderUrl, poNumber), poNumber);
  if (pdfs.length === 0 && digits) {
    pdfs = relevantPdfs(await searchSharedFolder(folderUrl, digits), poNumber);
  }
  return pickBest(pdfs, poNumber);
}

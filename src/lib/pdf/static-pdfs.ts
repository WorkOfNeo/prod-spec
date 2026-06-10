import { readFile } from "node:fs/promises";
import path from "node:path";

// Source artwork for static-pdf print specs (renderStrategy: 'static-pdf').
// The files in assets/print-specs/ are verbatim copies of the supplier
// reference PDFs ("Renamed PDFs/"), committed so the runner can emit them
// as job assets on any deploy target. Filenames match PrintSpec.sourcePdf
// exactly (NFC normalisation — what git stores).
const STATIC_PDF_DIR = path.join(process.cwd(), "assets", "print-specs");

export async function loadStaticPdf(fileName: string): Promise<Buffer> {
  // fileName comes from a spec's sourcePdf — always a bare filename.
  // basename() hard-stops any path traversal regardless.
  return readFile(path.join(STATIC_PDF_DIR, path.basename(fileName)));
}

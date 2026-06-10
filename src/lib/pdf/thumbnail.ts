import path from "node:path";
import { createRequire } from "node:module";

// =====================================================
// PDF → PNG rasteriser for the output thumbnails on the style detail page.
// Runs pdf.js inside Node with @napi-rs/canvas — no Puppeteer round-trip —
// so it renders the ACTUAL stored asset bytes, which makes it work for both
// template-rendered outputs and static-artwork passthrough PDFs alike.
//
// pdfjs-dist and @napi-rs/canvas are listed in `serverExternalPackages`
// (next.config.ts): pdf.js spins up an internal fake worker via dynamic
// import and the canvas package loads a native .node binary — neither
// survives being bundled.
// =====================================================

// cMaps + standard fonts let pdf.js draw text in PDFs that rely on the 14
// non-embedded standard fonts or CJK encodings (possible in uploaded
// artwork; our own Puppeteer output always embeds fonts). Resolved lazily —
// and anchored to process.cwd(), NOT import.meta.url: Turbopack rewrites
// import.meta.url to an internal module id in server chunks, which crashes
// createRequire during build-time page-data collection.
let pdfjsDir: string | null = null;
function resolvePdfjsDir(): string {
  if (!pdfjsDir) {
    const require_ = createRequire(path.join(process.cwd(), "package.json"));
    pdfjsDir = path.dirname(require_.resolve("pdfjs-dist/package.json"));
  }
  return pdfjsDir;
}

// Lazy single import — pdf.js is ~2 MB of JS we only want loaded (once) in
// processes that actually serve a thumbnail. The legacy build is the one
// pdf.js supports for Node use.
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJsModule> | null = null;
function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

// The Node canvas pdf.js creates through its NodeCanvasFactory — typed
// structurally because the factory getter is untyped (`Object`).
type NodeCanvasAndContext = {
  canvas: { toBuffer(mime: "image/png"): Buffer };
  context: CanvasRenderingContext2D;
};

/**
 * Render page 1 of a PDF to a PNG sized `targetWidthPx` wide (height keeps
 * the page's aspect ratio). Throws on unparsable bytes — callers decide how
 * to surface that.
 */
export async function renderPdfThumbnail(
  pdfBytes: Uint8Array,
  targetWidthPx: number
): Promise<Buffer> {
  const pdfjs = await loadPdfjs();
  const pkgDir = resolvePdfjsDir();

  // pdf.js takes ownership of (and may transfer) the buffer it's handed —
  // copy so the caller's bytes stay intact.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    cMapUrl: path.join(pkgDir, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pkgDir, "standard_fonts") + path.sep,
    // Errors only — artwork PDFs routinely trip benign font/colour warnings.
    verbosity: 0,
  });

  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);

    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidthPx / base.width });

    const canvasFactory = doc.canvasFactory as {
      create(width: number, height: number): NodeCanvasAndContext;
    };
    const { canvas, context } = canvasFactory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );

    // `canvasContext` (not `canvas`) because the factory's canvas is a Node
    // canvas, not an HTMLCanvasElement; pdf.js picks the canvas up from the
    // context. Background defaults to white, matching print.
    await page.render({
      canvasContext: context,
      canvas: null,
      viewport,
    }).promise;

    return canvas.toBuffer("image/png");
  } finally {
    await loadingTask.destroy();
  }
}

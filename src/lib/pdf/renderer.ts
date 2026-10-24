import puppeteer, { type Browser, type Page, type PDFOptions } from "puppeteer";

// Single shared browser per process. Puppeteer is heavy — we reuse the
// instance across renders to avoid the launch cost (~500ms) every time.
let cachedBrowser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.connected) return cachedBrowser;
  if (launchPromise) return launchPromise;
  launchPromise = puppeteer
    .launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
    })
    .then((b) => {
      cachedBrowser = b;
      launchPromise = null;
      b.on("disconnected", () => {
        if (cachedBrowser === b) cachedBrowser = null;
      });
      return b;
    });
  return launchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    await cachedBrowser.close().catch(() => undefined);
    cachedBrowser = null;
  }
}

export type RenderOptions = {
  html: string;
  pdf?: PDFOptions;
};

// Default print spec for Phase 1 — print-quality but RGB. If the supplier
// requires CMYK, swap renderer (WeasyPrint or a dedicated PDF service)
// before M2 ships. See plan note in §11.
const DEFAULT_PDF_OPTIONS: PDFOptions = {
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: "0", right: "0", bottom: "0", left: "0" },
};

// Load a document into a page the way every render needs it: print media,
// content loaded, web fonts settled, and the Output Builder fit scripts re-run
// against the real font metrics. Shared by renderPdf and renderHtmlPng so a
// proof picture can't measure text differently from the PDF.
async function loadForRender(page: Page, html: string): Promise<void> {
  await page.emulateMediaType("print");
  await page.setContent(html, { waitUntil: "load" });
  // Wait on the FontFaceSet promise so @import'd Google Fonts (barcode
  // font, etc.) have landed before the PDF snapshot. Without this, the
  // first cold render uses the fallback monospace font.
  await page.evaluate(() => document.fonts.ready);
  // Output Builder "fit width" blocks scale their text to the block width
  // via an in-page script (window.__olFitWidth). Re-run it here, after the
  // fonts have settled, so the PDF measures with the real metrics. No-op
  // for every other template (the global is undefined).
  await page
    .evaluate(() => {
      const fit = (window as unknown as { __olFitWidth?: () => void }).__olFitWidth;
      if (typeof fit === "function") fit();
    })
    .catch(() => undefined);
}

export async function renderPdf(opts: RenderOptions): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await loadForRender(page, opts.html);
    const result = await page.pdf({ ...DEFAULT_PDF_OPTIONS, ...opts.pdf });
    return Buffer.from(result);
  } finally {
    await page.close().catch(() => undefined);
  }
}

// CSS pixels per millimetre (96 dpi).
const PX_PER_MM = 96 / 25.4;

export type RenderPngOptions = {
  html: string;
  // The page box to picture — the document's FIRST page, at its printed size.
  widthMm: number;
  heightMm: number;
  // Device pixels per CSS pixel. 3 ≈ 288 dpi: small labels stay legible when
  // a reviewer zooms into a before/after proof.
  scale?: number;
};

// HTML → PNG of the first page (change-request proofs). Same shared browser
// and the same load steps as renderPdf; the viewport is the page box, so the
// document lays out at its printed width, and the shot is clipped to that box.
// A multi-page document's later pages stack below the clip and are not drawn.
export async function renderHtmlPng(opts: RenderPngOptions): Promise<Buffer> {
  const scale = opts.scale ?? 3;
  const widthPx = opts.widthMm * PX_PER_MM;
  const heightPx = opts.heightMm * PX_PER_MM;
  if (!(widthPx > 0) || !(heightPx > 0) || !(scale > 0)) {
    throw new Error(`renderHtmlPng: invalid page box ${opts.widthMm}×${opts.heightMm} mm at scale ${scale}`);
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Before the content loads, so the fit scripts measure at the final size.
    await page.setViewport({
      width: Math.ceil(widthPx),
      height: Math.ceil(heightPx),
      deviceScaleFactor: scale,
    });
    await loadForRender(page, opts.html);
    const shot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: widthPx, height: heightPx },
    });
    return Buffer.from(shot);
  } finally {
    await page.close().catch(() => undefined);
  }
}

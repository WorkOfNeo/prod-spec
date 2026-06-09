import puppeteer, { type Browser, type PDFOptions } from "puppeteer";

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

export async function renderPdf(opts: RenderOptions): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.emulateMediaType("print");
    await page.setContent(opts.html, { waitUntil: "load" });
    // Wait on the FontFaceSet promise so @import'd Google Fonts (barcode
    // font, etc.) have landed before the PDF snapshot. Without this, the
    // first cold render uses the fallback monospace font.
    await page.evaluate(() => document.fonts.ready);
    const result = await page.pdf({ ...DEFAULT_PDF_OPTIONS, ...opts.pdf });
    return Buffer.from(result);
  } finally {
    await page.close().catch(() => undefined);
  }
}

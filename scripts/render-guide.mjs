// Renders a self-contained guide HTML file to PDF using the project's Puppeteer
// (same launch flags as src/lib/pdf/renderer.ts so it matches this environment).
// Usage: node scripts/render-guide.mjs <input.html> <output.pdf>
import puppeteer from "puppeteer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/render-guide.mjs <input.html> <output.pdf>");
  process.exit(1);
}

// Load via file:// (not setContent) so a linked stylesheet (_guide.css) and any
// other same-dir assets resolve relative to the HTML file.
const url = pathToFileURL(resolve(inPath)).href;

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
});
try {
  const page = await browser.newPage();
  await page.emulateMediaType("print");
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: outPath,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });
  console.log("wrote", outPath);
} finally {
  await browser.close();
}

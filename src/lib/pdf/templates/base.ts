export function htmlDocument({
  title,
  pageSize = "A4",
  body,
  extraCss = "",
}: {
  title: string;
  pageSize?: "A4" | "A6" | "A7" | string;
  body: string;
  extraCss?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${pageSize}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #000; }
  body { font-size: 9pt; line-height: 1.3; }
  .page { page-break-after: always; padding: 8mm; }
  .page:last-child { page-break-after: auto; }
  h1, h2, h3 { font-weight: 600; margin: 0 0 4pt; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: 2pt 4pt; vertical-align: top; }
  .label { color: #666; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .barcode { text-align: center; }
  .barcode img { max-width: 100%; height: auto; }
  .small { font-size: 7pt; }
  ${extraCss}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function tFor(translations: Array<{ language: string; text: string }>, lang: string): string {
  return translations.find((t) => t.language === lang)?.text ?? "";
}

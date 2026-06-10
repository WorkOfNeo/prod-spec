import type { StyleData } from "@/lib/pdf/types";
import { escapeHtml, htmlDocument } from "@/lib/pdf/templates/base";
import { renderBarcodeDataUrl } from "@/lib/pdf/barcode";
import { TOKEN_RE, type LayoutAnchor, type LayoutBlock, type LayoutDef, type LayoutPage } from "./schema";
import { tokenMeta, type BarcodeSource } from "./token-meta";
import { resolveBarcodeValue, resolveTextToken } from "./tokens";

// =====================================================
// renderLayoutHtml — the ONE renderer for Output Builder layouts. The
// builder's live preview and the job runner both call this, so what the
// operator sees while building is byte-for-byte what prints.
//
// Modes:
//   • production — empty tokens render as nothing; a line that contained
//     ONLY tokens (all empty) is dropped, mirroring how coded templates
//     skip absent optional rows. Missing barcodes render the standard
//     `barcode-missing` tile so countPlaceholderMarkers() blocks
//     approval (src/lib/pdf/placeholders.ts).
//   • preview — gaps stay visible: empty tokens render as amber
//     `token?` chips, unknown tokens as red chips. Used by the builder
//     only; preview HTML never reaches the placeholder counter.
//
// Page sizes: every page gets a CSS named page (@page olp<i>) with its
// own mm size, so one PDF can carry differently-sized pages (e.g. a
// carton marking's 200×60 long side + 150×75 short side). Chromium
// honours named pages with `preferCSSPageSize: true` (renderer.ts).
// =====================================================

export type LayoutRenderMode = "production" | "preview";

export type LayoutRenderOptions = {
  mode?: LayoutRenderMode;
  // Render just this page (builder preview shows the selected page).
  pageIndex?: number;
  title?: string;
};

const ANCHOR_CSS: Record<LayoutAnchor, string> = {
  "top-left": "top: var(--ol-pad); left: var(--ol-pad); text-align: left;",
  "top-right": "top: var(--ol-pad); right: var(--ol-pad); text-align: right;",
  "bottom-left": "bottom: var(--ol-pad); left: var(--ol-pad); text-align: left;",
  "bottom-right": "bottom: var(--ol-pad); right: var(--ol-pad); text-align: right;",
};

type BarcodeCache = Map<string, string | null>; // "source:value" → data URL (null = encode failed)

async function buildBarcodeCache(def: LayoutDef, style: StyleData, pages: LayoutPage[]): Promise<BarcodeCache> {
  const wanted = new Map<string, { source: BarcodeSource; value: string }>();
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const m of line.matchAll(TOKEN_RE)) {
          if (m[1] !== "barcode") continue;
          const source = (m[2] ?? "cartonEan") as BarcodeSource;
          const value = resolveBarcodeValue(style, source);
          if (value) wanted.set(`${source}:${value}`, { source, value });
        }
      }
    }
  }
  const cache: BarcodeCache = new Map();
  await Promise.all(
    [...wanted.entries()].map(async ([cacheKey, { source, value }]) => {
      try {
        // Carton EANs print as Code 128 (EAN-128 family, matching the
        // carton-marking templates); per-size EANs as true EAN-13 with
        // the human-readable digits under the bars.
        const dataUrl =
          source === "cartonEan"
            ? await renderBarcodeDataUrl(value, { bcid: "code128", scale: 4, height: 16, includetext: false })
            : await renderBarcodeDataUrl(value, { bcid: "ean13", scale: 3, height: 14, includetext: true });
        cache.set(cacheKey, dataUrl);
      } catch {
        cache.set(cacheKey, null);
      }
    }),
  );
  return cache;
}

function renderBarcodeHtml(
  style: StyleData,
  source: BarcodeSource,
  cache: BarcodeCache,
  mode: LayoutRenderMode,
): string {
  const value = resolveBarcodeValue(style, source);
  if (!value) {
    const label = source === "cartonEan" ? "No carton EAN configured" : "No EAN-13 on style";
    return `<div class="barcode-missing">${escapeHtml(label)}</div>`;
  }
  const dataUrl = cache.get(`${source}:${value}`);
  if (!dataUrl) {
    return `<div class="barcode-missing">EAN ${escapeHtml(value)} — could not encode</div>`;
  }
  // Code 128 carries no digits in the bars image — print the number
  // beneath; EAN-13 already includes its text (includetext: true).
  const numberRow = source === "cartonEan" ? `<div class="ol-ean-number">${escapeHtml(value)}</div>` : "";
  return `<span class="ol-barcode${mode === "preview" ? " ol-barcode-preview" : ""}"><img src="${dataUrl}" alt="${escapeHtml(value)}" />${numberRow}</span>`;
}

// Render one content line: literal text escaped, tokens replaced.
// Returns null when the line should be dropped (production mode, line
// was only empty tokens / whitespace).
function renderLine(
  line: string,
  style: StyleData,
  cache: BarcodeCache,
  mode: LayoutRenderMode,
): string | null {
  let html = "";
  let lastIndex = 0;
  let hadToken = false;
  let hadValue = false;
  let literal = "";

  for (const m of line.matchAll(TOKEN_RE)) {
    hadToken = true;
    const [raw, key, argRaw] = m;
    const arg = argRaw || undefined;
    const before = line.slice(lastIndex, m.index);
    literal += before;
    html += escapeHtml(before);
    lastIndex = (m.index ?? 0) + raw.length;

    const meta = tokenMeta(key);
    if (!meta) {
      // Unknown token — publish validation rejects these; if one slips
      // through (or in the builder mid-typing), surface it.
      html +=
        mode === "preview"
          ? `<span class="ol-unknown">${escapeHtml(raw)}</span>`
          : `<span class="missing">${escapeHtml(raw)}</span>`;
      hadValue = true; // keep the line visible — it's an authoring error
      continue;
    }

    if (meta.kind === "barcode") {
      const source = (arg ?? "cartonEan") as BarcodeSource;
      html += renderBarcodeHtml(style, source, cache, mode);
      hadValue = true; // barcode renders something in every state
      continue;
    }

    const value = resolveTextToken(style, key, arg);
    if (value) {
      html += escapeHtml(value);
      hadValue = true;
    } else if (mode === "preview") {
      html += `<span class="ol-miss">${escapeHtml(key + (arg ? `:${arg}` : ""))}?</span>`;
    }
    // production + empty → nothing
  }

  const rest = line.slice(lastIndex);
  literal += rest;
  html += escapeHtml(rest);

  // Drop token-only lines whose tokens all came up empty (production).
  if (mode === "production" && hadToken && !hadValue && !literal.trim()) return null;
  return html;
}

function renderBlock(
  block: LayoutBlock,
  page: LayoutPage,
  style: StyleData,
  cache: BarcodeCache,
  mode: LayoutRenderMode,
): string {
  const widthMm = (page.widthMm * block.cols) / 12;
  const lines = block.lines
    .map((line) => renderLine(line, style, cache, mode))
    .filter((l): l is string => l !== null)
    .map((l) => `<div class="ol-line">${l || "&nbsp;"}</div>`)
    .join("");
  const styleAttr =
    `width: ${widthMm.toFixed(2)}mm; ` +
    `font-size: ${block.fontPt}pt; ` +
    `line-height: ${block.lineHeight}; ` +
    `font-weight: ${block.bold ? 700 : 400}; ` +
    ANCHOR_CSS[block.anchor];
  return `<div class="ol-block ol-${block.anchor}" style="${styleAttr}">${lines}</div>`;
}

export async function renderLayoutHtml(
  def: LayoutDef,
  style: StyleData,
  opts: LayoutRenderOptions = {},
): Promise<string> {
  const mode = opts.mode ?? "production";
  const pages =
    opts.pageIndex !== undefined
      ? def.pages.slice(opts.pageIndex, opts.pageIndex + 1)
      : def.pages;
  if (pages.length === 0) {
    throw new Error(`layout has no page at index ${opts.pageIndex}`);
  }

  const cache = await buildBarcodeCache(def, style, pages);

  const pageCss = pages
    .map(
      (p, i) => `
  @page olp${i} { size: ${p.widthMm}mm ${p.heightMm}mm; margin: 0; }
  .ol-page-${i} { page: olp${i}; width: ${p.widthMm}mm; height: ${p.heightMm}mm; }`,
    )
    .join("");

  const body = pages
    .map((page, i) => {
      const blocks = page.blocks.map((b) => renderBlock(b, page, style, cache, mode)).join("");
      return `<div class="ol-page ol-page-${i}">${blocks}</div>`;
    })
    .join("\n");

  return htmlDocument({
    title: opts.title ?? "Output layout",
    pageSize: { kind: "mm", widthMm: pages[0].widthMm, heightMm: pages[0].heightMm },
    body,
    barcodeFont: style.barcodeFont,
    extraCss: `
  :root { --ol-pad: 2mm; }
  .ol-page {
    position: relative;
    overflow: hidden;
    page-break-after: always;
    background: #fff;
  }
  .ol-page:last-child { page-break-after: auto; }
  ${pageCss}
  .ol-block { position: absolute; }
  .ol-line { white-space: pre-wrap; word-break: break-word; min-height: 1em; }
  .ol-barcode { display: inline-block; text-align: center; max-width: 100%; }
  .ol-barcode img { display: block; height: 16mm; width: auto; max-width: 100%; margin-left: auto; margin-right: auto; }
  .ol-ean-number { margin-top: 1mm; font-size: 10pt; letter-spacing: 0.08em; }
  .barcode-missing {
    font-size: 8pt; color: #a00; text-align: center; padding: 2mm;
    border: 0.2mm dashed #a00; border-radius: 1mm; display: inline-block;
  }
  .ol-miss {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fffbeb; color: #b45309; border: 0.2mm dashed #f59e0b;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
  .ol-unknown {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fef2f2; color: #b91c1c; border: 0.2mm dashed #ef4444;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
  .missing {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fef2f2; color: #b91c1c; border: 0.2mm dashed #ef4444;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
`,
  });
}

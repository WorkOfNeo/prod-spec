import type { StyleData, SizeVariant } from "@/lib/pdf/types";
import { escapeHtml, htmlDocument } from "@/lib/pdf/templates/base";
import { renderBarcodePng } from "@/lib/pdf/barcode";
import {
  getWashcareSymbol,
  loadWashcareSymbols,
  type WashcareSymbolMap,
} from "@/lib/pdf/washcare-symbols";
import { certDeclaredBy, findCertificate, loadCertificates, type CertificateMap } from "@/lib/pdf/certificates";
import { findLayoutImage, loadLayoutImages, type LayoutImageMap } from "./images";
import {
  TOKEN_RE,
  conditionalsInLine,
  effectiveBorderPad,
  effectiveBorderSides,
  insetCornerRadiusMm,
  invertColors,
  isFullBorder,
  layoutSettings,
  pageGrid,
  type BorderSides,
  type LayoutAnchor,
  type LayoutBlock,
  type LayoutDef,
  type LayoutPage,
} from "./schema";
import { tokenMeta, TABLE_TOTAL_ARG, type BarcodeSource, type LogoSource } from "./token-meta";
import { lineOverrideKey } from "./line-keys";
import { narrowSizeScopedText } from "./size-scoped-text";
import { parseSizeForm, sizeFormEntries } from "./size-form";
import { formatSizeRatioTotal } from "./size-ratio";
import { CALC_RE, fieldsInCalcExpression } from "./calc";
import { getContrastAddressLogoDataUrl, getContrastLogoDataUrl } from "./logos";
import {
  applyConditionalsForStyle,
  augmentTranslatedFields,
  augmentCompositionTranslations,
  compositionLangsInDef,
  evaluateCalcForStyle,
  langArgsInDef,
  resolveBarcodeValue,
  resolveTextToken,
  sizeRatioEntries,
} from "./tokens";

// =====================================================
// renderLayoutHtml — the ONE renderer for Output Builder layouts. The
// builder's live preview and the job runner both call this, so what the
// operator sees while building is byte-for-byte what prints.
//
// Pipeline per line: conditionals first ({{if field == VALUE}}…
// {{else}}…{{endif}} evaluated against StyleData — taken branch only),
// then token resolution.
//
// Modes:
//   • production — empty tokens render as nothing; a line that contained
//     ONLY tokens (all empty) is dropped, mirroring how coded templates
//     skip absent optional rows. Missing barcodes render the standard
//     `barcode-missing` tile and missing wash-symbol artwork the standard
//     `missing` chip, so countPlaceholderMarkers() blocks approval
//     (src/lib/pdf/placeholders.ts).
//   • preview — gaps stay visible: empty tokens render as amber
//     `token?` chips, unknown tokens as red chips. Used by the builder
//     only; preview HTML never reaches the placeholder counter.
//
// Graphics scale with the block's font size (9 pt = the classic sizes):
//   barcode bars  fontPt × 16/9 mm     EAN digits  fontPt × 10/9 pt
//   wash symbols  fontPt × 6/9 mm
// Exception: {{barcode:…:H}} sets an explicit bar height of H mm — the
// symbol then prints at true physical size (standard module width, digits
// unscaled) regardless of the block font. See renderBarcodeHtml.
//
// Page sizes: every page gets a CSS named page (@page olp<i>) with its
// own mm size, so one PDF can carry differently-sized pages. Chromium
// honours named pages with `preferCSSPageSize: true` (renderer.ts).
// =====================================================

export type LayoutRenderMode = "production" | "preview";

// The per-repetition style narrowings for a repeat mode:
//   "size" — one per size row ({{size}}/{{ean13}} bind to the row)
//   "ean"  — one per PO EAN row (SIZE × COLOUR; {{colourName}} binds the
//            row's colour parsed from the PO variant label). Falls back
//            to size rows when no EAN rows were scraped.
export function repetitionStyles(
  style: StyleData,
  repeatBy: "none" | "size" | "ean" | "assort" | "cartonEan",
): StyleData[] {
  // The full size run, preserved as we narrow `sizes` to one row per
  // repetition so {{sizeRangeCoop}} can still list every size and enlarge
  // the current one. `?? style.sizes` keeps it idempotent: renderLayoutHtml
  // re-applies repetitionStyles to already-narrowed styles, and an
  // already-set allSizes must survive that second pass.
  const allSizes = style.allSizes ?? style.sizes;
  // Buyers fill some text columns as per-size lists keyed by the style's own
  // size labels ("4-5 ÅR: 7307204, 6-7 ÅR: …") — one entry per size, same
  // convention as the barcode columns. A repetition row narrowed to size(s)
  // prints ITS entry, not the whole list. No size anchors in the value (or
  // none matching the row) → the raw value stands (see size-scoped-text.ts).
  // Idempotent like the rest of the narrowing: a narrowed value carries no
  // "<size>:" anchor, so the second repetitionStyles pass leaves it alone.
  // Anchor vocabulary = every size label the style knows, whatever the source
  // (sizes column, PO EAN rows, per-size cartons) — `sizes` alone can be a
  // subset (it dedupes by the ean-map string).
  const allLabels = [
    ...allSizes.map((s) => s.label),
    ...(style.eanVariants ?? []).map((v) => v.size),
    ...(style.carton.perSize ?? []).map((v) => v.size),
  ];
  const sizeScoped = (rowSizes: readonly SizeVariant[]) => {
    const rowLabels = rowSizes.map((s) => s.label);
    return {
      customerItemNo: narrowSizeScopedText(style.customerItemNo, allLabels, rowLabels),
      description: narrowSizeScopedText(style.description, allLabels, rowLabels),
      // The carton-qty column writes its per-size lists with "=" instead of
      // ":" ("4-5ÅR=1040, 6-7ÅR=1050"); accept both.
      cartonQtyRaw: narrowSizeScopedText(style.cartonQtyRaw, allLabels, rowLabels, [":", "="]),
    };
  };
  if (repeatBy === "size" && style.sizes.length > 0) {
    return style.sizes.map((entry) => ({
      ...style,
      sizes: [entry],
      allSizes,
      ...sizeScoped([entry]),
    }));
  }
  if (repeatBy === "ean") {
    const rows = style.eanVariants ?? [];
    if (rows.length > 0) {
      // eanVariants is narrowed along with sizes so the narrowing is
      // idempotent — renderLayoutHtml re-applies repetitionStyles to the
      // styles renderMany already narrowed, and a full eanVariants list
      // would re-expand every per-EAN file back to ALL EAN rows.
      return rows.map((v) => ({
        ...style,
        sizes: [{ label: v.size, ean13: v.ean13 }],
        allSizes,
        ...sizeScoped([{ label: v.size, ean13: v.ean13 }]),
        eanVariants: [v],
        // Colour name for this per-EAN row: normally the PO variant label's
        // colour (v.colour), which keeps multi-colourway packs distinct. When
        // the style opts into the board colour (useStyleBoardColour), keep
        // style.colour instead. Either way the CODE stays the board's.
        colour:
          !style.useStyleBoardColour && v.colour
            ? { name: v.colour, code: style.colour?.code ?? "" }
            : style.colour,
        // Bind this colourway's own carton EAN so {{cartonEan}} /
        // {{barcode:cartonEan}} print the right carton per colour; fall back to
        // the style's representative carton when the row carries none.
        carton: { ...style.carton, ean13: v.cartonEan || style.carton.ean13 },
      }));
    }
    if (style.sizes.length > 0) {
      return style.sizes.map((entry) => ({
        ...style,
        sizes: [entry],
        allSizes,
        ...sizeScoped([entry]),
      }));
    }
  }
  if (repeatBy === "assort") {
    // One label per resolved ASSORTMENT (master) carton EAN — a single value
    // on the style today (carton.assortEan). Bind it onto carton.ean13 too so
    // {{barcode:cartonEan}} prints the assort on this row (not a per-size
    // carton), and flag it {{isAssortment}}. When no assort is resolved we
    // still emit one row so the label surfaces its missing-barcode state and
    // readiness flags {{assortEan}} as an editable field to fill in review.
    const assortEan = resolveBarcodeValue(style, "assortEan");
    return [
      {
        ...style,
        allSizes,
        isAssortment: true,
        ...(assortEan ? { carton: { ...style.carton, ean13: assortEan } } : {}),
      },
    ];
  }
  if (repeatBy === "cartonEan") {
    // One label per DISTINCT carton EAN the style carries (carton.perSize) —
    // each row narrowed to the size(s) that share that carton, with the carton
    // bound onto carton.ean13 so {{barcode:cartonEan}} / {{barcode:cartonEan13}}
    // print it. Then ONE more row for the master assortment carton (flagged
    // {{isAssortment}}), so a single run emits every size carton + the assort.
    // Sizes sharing a carton collapse into one label (dedup by EAN value);
    // {{size}} shows the first, {{sizes}}/{{sizeRange}} list them all.
    //
    // IDEMPOTENCY: renderMany narrows the style to one carton row and hands it
    // back to renderLayoutHtml, which re-applies repetitionStyles. A narrowed row
    // is flagged isCartonRow and returns as-is — without this it would re-expand
    // (its carton.perSize is inherited) and every per-carton PDF would contain
    // ALL the markings. Narrowing perSize below is belt-and-braces for the same.
    if (style.isCartonRow) return [style];
    const byCarton = new Map<
      string,
      { sizes: SizeVariant[]; colour: string | null; rows: NonNullable<StyleData["carton"]["perSize"]> }
    >();
    for (const v of style.carton.perSize ?? []) {
      if (!v.cartonEan) continue;
      const group = byCarton.get(v.cartonEan) ?? { sizes: [], colour: v.colour, rows: [] };
      group.sizes.push({ label: v.size, ean13: v.productEan13 });
      group.rows.push(v);
      byCarton.set(v.cartonEan, group);
    }
    const rows: StyleData[] = [...byCarton.entries()].map(([cartonEan, group]) => ({
      ...style,
      isCartonRow: true,
      sizes: group.sizes,
      allSizes,
      // Sizes sharing a carton collapse to one row — matched entries join
      // with ", " (the assort row below keeps the raw whole-style value).
      ...sizeScoped(group.sizes),
      carton: { ...style.carton, ean13: cartonEan, perSize: group.rows },
      colour: group.colour ? { name: group.colour, code: style.colour?.code ?? "" } : style.colour,
    }));
    // Append the assortment master carton as a final row when the style has one
    // (same binding as repeatBy="assort"). No per-size cartons AND no assort ⇒
    // fall back to the whole style so the layout still renders (missing state
    // visible) rather than producing zero files.
    const assortEan = resolveBarcodeValue(style, "assortEan");
    if (assortEan) {
      rows.push({
        ...style,
        isCartonRow: true,
        isAssortment: true,
        allSizes,
        carton: { ...style.carton, ean13: assortEan, perSize: [] },
      });
    }
    return rows.length > 0 ? rows : [style];
  }
  return [style];
}

export type LayoutRenderOptions = {
  mode?: LayoutRenderMode;
  // Render just this page (builder preview shows the selected page).
  pageIndex?: number;
  title?: string;
  // Info-area size override: when set, EVERY page renders at these mm
  // dimensions instead of its own. Blocks are grid-positioned (proportional
  // to page size), so the whole design simply scales to the chosen size.
  // Passed by the runner / preview routes for outputs whose variant is an
  // info area (TemplateVariant.isInfoArea). Margins are absolute and kept.
  sizeOverrideMm?: { widthMm: number; heightMm: number };
  // Per-layout {{logo:custom}} image (data URL). Threaded in by the caller
  // (variant render closure from OutputLayout.customLogo, or the builder
  // preview route by layout id) — there is no global custom logo anymore.
  customLogo?: string | null;
  // Pre-loaded image library for {{image:<slug>}}. Omitted on every real
  // caller — the renderer loads it itself, and only when the definition
  // places one. Present so a caller that already holds the map (and a unit
  // test) can render without a DB round-trip.
  layoutImages?: LayoutImageMap;
  // Reviewer line overrides for THIS document: lineOverrideKey(page, block,
  // index) → replacement SOURCE line. Substituted for the authored line before
  // conditionals and tokens run, so an override resolves exactly as an authored
  // line would. The escape hatch for text no field pin can reach — see
  // output-line-values.ts. Absent on every non-reviewer path (builder preview,
  // proofs), which keeps this inert by default.
  lineOverrides?: Record<string, string>;
};

// Keep an overridden page size inside the LayoutPage schema's mm bounds.
function clampMm(mm: number): number {
  if (!Number.isFinite(mm)) return 5;
  return Math.min(1000, Math.max(5, mm));
}

const ANCHOR_CSS: Record<LayoutAnchor, string> = {
  "top-left": "top: var(--ol-pad); left: var(--ol-pad);",
  "top-right": "top: var(--ol-pad); right: var(--ol-pad);",
  "bottom-left": "bottom: var(--ol-pad); left: var(--ol-pad);",
  "bottom-right": "bottom: var(--ol-pad); right: var(--ol-pad);",
};

const ANCHOR_ALIGN: Record<LayoutAnchor, "left" | "right"> = {
  "top-left": "left",
  "top-right": "right",
  "bottom-left": "left",
  "bottom-right": "right",
};

type RenderCtx = {
  mode: LayoutRenderMode;
  barcodes: BarcodeCache; // "symbology:height:value" → rendered PNG (null = encode failed)
  symbols: WashcareSymbolMap | null; // loaded only when {{washSymbols}} is used
  logos: { contrast: string | null; contrastAddress: string | null; custom: string | null }; // loaded only when {{logo:…}} is used
  certs: CertificateMap | null; // loaded only when {{cert:…}} is used
  images: LayoutImageMap | null; // loaded only when {{image:…}} is used
  // Uniform shrink applied to font-derived sizes (font pt, barcode/symbol/
  // logo dimensions, borders, padding) so the whole design scales — not just
  // the grid-relative positions — when an info-area size override resizes the
  // page. 1 = no scaling (normal render / builder). See prepareLayoutRender.
  fontScale: number;
  // Print width of the {{logo:custom}} image as a % of its block (height
  // auto). %-based, so it already scales with the page — no fontScale.
  customLogoWidthPct: number;
  // Reviewer line overrides (see LayoutRenderOptions.lineOverrides).
  // undefined on every path that isn't a reviewer-corrected render.
  lineOverrides?: Record<string, string>;
};

// Does this page set print a certification mark that one of the rendered
// styles actually DECLARES? {{cert:x}} is gated on the style's Monday
// "Certificates" column, so a style declaring none needs no library at all
// — and skipping the load keeps the conditional-certificate-page case (which
// is by definition a style WITHOUT the cert) free of a DB round-trip.
function printsDeclaredCert(pages: LayoutPage[], styles: StyleData[]): boolean {
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
          const source = m[2];
          if (m[1] !== "cert" || !source) continue;
          if (styles.some((s) => certDeclaredBy(s.certificates, source))) return true;
        }
      }
    }
  }
  return false;
}

function defUsesToken(pages: LayoutPage[], key: string): boolean {
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
          if (m[1] === key) return true;
        }
      }
    }
  }
  return false;
}

// Effective symbology for a barcode token: per-size EANs are always true
// EAN-13; the carton EAN follows the per-spec preference carried on
// StyleData.cartonBarcode (set from the ProdSpec output row by
// applyCartonBarcodePrefs) — EAN-128 / Code 128 when absent, the
// historic default.
type BarcodeSymbology = "ean128" | "ean13";

export function barcodeSymbology(style: StyleData, source: BarcodeSource): BarcodeSymbology {
  // Only cartonEan / assortEan follow the style's carton symbology preference
  // (Code128 by default, or EAN-13 when the ProdSpec row's dropdown is set).
  // Every other source — the per-size product barcode (ean13) and the explicit
  // cartonEan13 / assortEan13 sources — prints as a true EAN-13, so a layout
  // picks EAN-128 vs EAN-13 per barcode for the same carton/master value.
  if (source !== "cartonEan" && source !== "assortEan") return "ean13";
  return style.cartonBarcode?.type ?? "ean128";
}

// Rendered barcode PNG + its true physical size in mm (bars AND the
// human-readable digit row) — needed to print an explicit-height barcode at
// actual size instead of stretching it to the block's font-scaled default.
// widthMm is the symbol's 100%-magnification width (for EAN-13 ≈ the GS1
// nominal 37.3 mm incl. light-margin digits); the fit logic scales the
// printed width between 80% and 100% of it.
type BarcodeEntry = { dataUrl: string; totalMm: number; widthMm: number };
type BarcodeCache = Map<string, BarcodeEntry | null>;

// Optional {{barcode:…:H}} second argument — explicit bar height in mm.
// Mirrors validateTokenRef's 2–40 mm publish gate; out-of-range/garbage
// degrades to the default font-scaled sizing instead of breaking a print.
function parseBarHeightMm(arg2: string | undefined): number | null {
  if (arg2 === undefined) return null;
  const n = Number(arg2);
  return Number.isFinite(n) && n >= 2 && n <= 40 ? n : null;
}

function barcodeCacheKey(symbology: BarcodeSymbology, heightMm: number | null, value: string): string {
  return `${symbology}:${heightMm ?? ""}:${value}`;
}

// bwip-js renders at 72 dpi × scale, so px ↔ mm is exact: 1 mm = scale ×
// 72/25.4 px. Reading the PNG's IHDR height (bytes 20–23) therefore gives
// the symbol's true physical height including the digit row bwip appends
// below the bars (includetext).
const BWIP_PX_PER_MM = 72 / 25.4;

function pngWidthPx(png: Buffer): number {
  return png.readUInt32BE(16);
}

function pngHeightPx(png: Buffer): number {
  return png.readUInt32BE(20);
}

// GS1 lower bound for EAN magnification — a symbol printed narrower than
// 80% of nominal is out of spec and starts failing at POS scanners. Fixed-
// size barcodes fit their block down to this floor, then turn into a
// visible warning chip instead of silently printing an unscannable code.
const MIN_MAGNIFICATION = 0.8;

// bwip-js rounds each module up to whole pixels, rendering the symbol a
// shade wider than GS1-nominal geometry (37.51 mm vs 37.29 mm for EAN-13).
// Judged against the rendered width alone, a 30 mm block — fine by nominal
// math (floor 29.83 mm) — would chip on a rounding hair. This factor backs
// the floor off to the nominal-geometry equivalent.
const FLOOR_TOLERANCE = 0.995;

async function buildBarcodeCache(styles: StyleData[], pages: LayoutPage[]): Promise<BarcodeCache> {
  const wanted = new Map<string, { symbology: BarcodeSymbology; heightMm: number | null; value: string }>();
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
          if (m[1] !== "barcode") continue;
          const source = (m[2] ?? "cartonEan") as BarcodeSource;
          const heightMm = parseBarHeightMm(m[3]);
          for (const style of styles) {
            const value = resolveBarcodeValue(style, source);
            if (!value) continue;
            const symbology = barcodeSymbology(style, source);
            wanted.set(barcodeCacheKey(symbology, heightMm, value), { symbology, heightMm, value });
          }
        }
      }
    }
  }
  const cache: BarcodeCache = new Map();
  await Promise.all(
    [...wanted.entries()].map(async ([cacheKey, { symbology, heightMm, value }]) => {
      try {
        // EAN-128 (the carton default) prints as Code 128 bars with the
        // number as a separate HTML row beneath; true EAN-13 carries the
        // human-readable digits inside the symbol (includetext). An explicit
        // {{barcode:…:H}} height is baked into the bars here, so the module
        // width and digit size stay standards-correct at any bar height.
        const scale = symbology === "ean128" ? 4 : 3;
        const png =
          symbology === "ean128"
            ? await renderBarcodePng(value, { bcid: "code128", scale, height: heightMm ?? 16, includetext: false })
            : await renderBarcodePng(value, { bcid: "ean13", scale, height: heightMm ?? 14, includetext: true });
        cache.set(cacheKey, {
          dataUrl: `data:image/png;base64,${png.toString("base64")}`,
          totalMm: pngHeightPx(png) / (scale * BWIP_PX_PER_MM),
          widthMm: pngWidthPx(png) / (scale * BWIP_PX_PER_MM),
        });
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
  ctx: RenderCtx,
  heightArg?: string,
  blockWidthMm?: number,
): string {
  const value = resolveBarcodeValue(style, source);
  if (!value) {
    const label =
      source === "ean13"
        ? "No EAN-13 on style"
        : source === "assortEan" || source === "assortEan13"
          ? "No assortment EAN configured"
          : "No carton EAN configured";
    return `<div class="barcode-missing">${escapeHtml(label)}</div>`;
  }
  const symbology = barcodeSymbology(style, source);
  const tokenHeightMm = parseBarHeightMm(heightArg);
  const entry = ctx.barcodes.get(barcodeCacheKey(symbology, tokenHeightMm, value));
  if (!entry) {
    return `<div class="barcode-missing">EAN ${escapeHtml(value)} — could not encode</div>`;
  }
  // Code 128 carries no digits in the bars image — print the number
  // beneath; EAN-13 includes its text in the symbol (includetext: true).
  const numberRow = symbology === "ean128" ? `<div class="ol-ean-number">${escapeHtml(value)}</div>` : "";
  // Display sizing, by precedence:
  //   1. {{barcode:…:H}} token argument — FIXED PHYSICAL SIZE. Bars are H mm
  //      on every info-area size (deliberately NOT fontScale-scaled: the
  //      barcode is the one element with a legal minimum, so the design
  //      shrinks around it). Width auto-fits the block by adjusting the
  //      magnification — scanners read relative bar widths, so a uniform
  //      horizontal squeeze IS a magnification change — but never below the
  //      80% GS1 floor: a block too narrow for 80% renders the standard
  //      `barcode-missing` chip instead (visible on preview + proof, counted
  //      by the placeholder gate, so it can never ship silently).
  //   2. Per-spec carton bar height (ProdSpec output row) — carton sources
  //      only (either symbology). Legacy: uniformly scales the default PNG.
  //   3. Block default — CSS var --ol-bc-h (fontPt × 16/9 mm).
  if (tokenHeightMm != null) {
    const natural = entry.widthMm; // 100% magnification
    const floor = natural * MIN_MAGNIFICATION * FLOOR_TOLERANCE;
    const avail = blockWidthMm ?? natural;
    if (avail < floor) {
      // The block genuinely cannot hold a scannable symbol (the whole PNG —
      // bwip draws the HRI digits flush to its edges, so nothing about it is
      // croppable, and the info-area PDF page IS the physical print, so
      // there's no surrounding stock to overhang onto). Chip in BOTH modes:
      // visible while designing, printed on the proof, counted by the
      // placeholder gate so the output can't be approved.
      return `<div class="barcode-missing">Barcode won't scan at this size — needs ${floor.toFixed(1)} mm, block is ${avail.toFixed(1)} mm wide</div>`;
    }
    const printWidth = Math.min(avail, natural);
    // width + height set independently: height pins the bars at H mm, width
    // sets the magnification (80–100%). max-width:none guards against the
    // stylesheet's max-width:100% re-squashing an already-clamped symbol.
    const imgStyle = ` style="height: ${entry.totalMm.toFixed(3)}mm; width: ${printWidth.toFixed(3)}mm; max-width: none"`;
    return `<span class="ol-barcode${ctx.mode === "preview" ? " ol-barcode-preview" : ""}"><img src="${entry.dataUrl}"${imgStyle} alt="${escapeHtml(value)}" />${numberRow}</span>`;
  }
  const specHeightMm =
    source === "cartonEan" || source === "cartonEan13" ? style.cartonBarcode?.heightMm : undefined;
  const imgStyle = specHeightMm ? ` style="height: ${specHeightMm}mm"` : "";
  return `<span class="ol-barcode${ctx.mode === "preview" ? " ol-barcode-preview" : ""}"><img src="${entry.dataUrl}"${imgStyle} alt="${escapeHtml(value)}" />${numberRow}</span>`;
}

// Wash-care symbol strip — same honest-gap rules as the coded templates
// (netto info-area): artwork renders as an <img>; a known symbol with no
// uploaded SVG (or an unknown token) renders the tagged `missing` chip
// so the gap is visible on the proof and counted by the placeholder gate.
// `gapArg` is the optional {{washSymbols:N}} value — the strip's gap in mm
// (0 = symbols flush together). Absent/invalid ⇒ the default 1.5 mm CSS gap.
// A set gap is scaled with the rest of the design (fontScale), so 0 stays 0.
function renderWashSymbolsHtml(style: StyleData, ctx: RenderCtx, gapArg?: string): string {
  if (style.washSymbols.length === 0) {
    return ctx.mode === "preview" ? `<span class="ol-miss">washSymbols?</span>` : "";
  }
  const map = ctx.symbols;
  const items = style.washSymbols
    .map((token) => {
      const resolved = map ? getWashcareSymbol(map, token) : undefined;
      if (resolved?.dataUrl) {
        return `<img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      const label = resolved?.name ?? token;
      return `<span class="missing" title="No SVG uploaded for &quot;${escapeHtml(token)}&quot;">${escapeHtml(label)}</span>`;
    })
    .join("");
  const gapMm = gapArg !== undefined ? Number(gapArg) : NaN;
  const gapStyle =
    Number.isFinite(gapMm) && gapMm >= 0
      ? ` style="gap: ${(gapMm * ctx.fontScale).toFixed(3)}mm"`
      : "";
  return `<span class="ol-symbols"${gapStyle}>${items}</span>`;
}

// Render one content line: conditionals already applied by the caller;
// literal text escaped, tokens replaced. Returns null when the line
// should be dropped (production mode, line was only empty tokens /
// whitespace).
function renderLine(line: string, style: StyleData, ctx: RenderCtx, blockWidthMm?: number): string | null {
  // Carton-number lines belong ONLY on a numbered print. A line like
  // "Carton {{cartonNo}} of {{cartonTotal}}" carries literal text, so the
  // token-only drop below would NOT fire — it would print "Carton  of ".
  // In production without a carton serial (i.e. standard generation), drop
  // the whole line so a carton-numbering layout's standard output is clean.
  if (ctx.mode === "production" && !style.cartonSerial) {
    for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
      if (m[1] === "cartonNo" || m[1] === "cartonTotal" || m[1] === "cartonNoPadded") return null;
    }
    // Same rule for a calc that READS a carton serial field — a line like
    // "Run total: {{= qtyPerCarton * cartonTotal }}" belongs only on a
    // numbered print.
    for (const m of line.matchAll(new RegExp(CALC_RE.source, "g"))) {
      const { fields } = fieldsInCalcExpression(m[1]);
      if (fields.some((k) => k === "cartonNo" || k === "cartonTotal" || k === "cartonNoPadded")) {
        return null;
      }
    }
  }

  let html = "";
  let lastIndex = 0;
  let hadToken = false;
  let hadValue = false;
  let literal = "";

  // One left-to-right pass over plain tokens AND calc tokens. The two
  // grammars can't overlap (TOKEN_RE requires a letter after "{{", a calc
  // body carries no braces), so a sorted merge of both match sets walks
  // every substitution site exactly once.
  const matches = [
    ...[...line.matchAll(new RegExp(TOKEN_RE.source, "g"))].map((m) => ({ m, isCalc: false })),
    ...[...line.matchAll(new RegExp(CALC_RE.source, "g"))].map((m) => ({ m, isCalc: true })),
  ].sort((a, b) => (a.m.index ?? 0) - (b.m.index ?? 0));

  for (const { m, isCalc } of matches) {
    hadToken = true;
    const [raw, key, argRaw] = m;
    const arg = argRaw || undefined;
    const before = line.slice(lastIndex, m.index);
    literal += before;
    html += escapeHtml(before);
    lastIndex = (m.index ?? 0) + raw.length;

    // Calculated field — group 1 is the expression body. Resolved → the
    // number as literal text; unresolved → amber chip in preview, nothing
    // in production (line-drop accounting matches plain tokens).
    if (isCalc) {
      const value = evaluateCalcForStyle(key, style);
      if (value !== null) {
        html += escapeHtml(value);
        hadValue = true;
      } else if (ctx.mode === "preview") {
        html += `<span class="ol-miss">= ${escapeHtml(key)}?</span>`;
      }
      continue;
    }

    const meta = tokenMeta(key);
    if (!meta) {
      // Unknown token — publish validation rejects these; if one slips
      // through (or in the builder mid-typing), surface it.
      html +=
        ctx.mode === "preview"
          ? `<span class="ol-unknown">${escapeHtml(raw)}</span>`
          : `<span class="missing">${escapeHtml(raw)}</span>`;
      hadValue = true; // keep the line visible — it's an authoring error
      continue;
    }

    if (meta.kind === "barcode") {
      const source = (arg ?? "cartonEan") as BarcodeSource;
      html += renderBarcodeHtml(style, source, ctx, m[3] || undefined, blockWidthMm);
      hadValue = true; // barcode renders something in every state
      continue;
    }

    if (meta.kind === "image" && key === "cert") {
      // Certification mark — printed ONLY when THIS style declares the
      // cert in its Monday "Certificates" column (free text "FSC,
      // OEKO-TEX", matched case/punctuation-insensitively). A style may
      // declare FSC, OEKOTEX, both or neither, so one layout can carry
      // both {{cert:oekotex}} and {{cert:fsc}} and each appears only where
      // relevant — exactly like the coded care labels (care-label-02 /
      // spec-generic). No {{if certificates includes …}} wrapper needed.
      if (!arg || !certDeclaredBy(style.certificates, arg)) {
        // Not declared on this style — render nothing (a token-only line
        // drops in production). In the builder preview, a subtle amber
        // hint so the operator sees the mark is gated, not broken.
        if (ctx.mode === "preview") {
          html += `<span class="ol-miss">cert:${escapeHtml(arg ?? "")} — not on style</span>`;
        }
        continue; // leave hadValue untouched so the line can still drop
      }
      // Declared: show the artwork from the Certificate library (Settings
      // → Certificates) — the same pool care-label-02 prints, so builder
      // layouts and coded templates can never show different art.
      const resolved = ctx.certs ? findCertificate(ctx.certs, arg) : null;
      if (resolved?.dataUrl) {
        html += `<span class="ol-cert"><img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" /></span>`;
      } else {
        // Declared but no library row / no artwork / row deactivated —
        // the established cert chip: visible on the proof in both modes
        // and counted by countPlaceholderMarkers(), so approval stays
        // blocked while a declared mark is missing its artwork.
        html += `<span class="cert-missing">${escapeHtml(arg)} — no artwork in Settings → Certificates</span>`;
      }
      hadValue = true;
      continue;
    }

    if (meta.kind === "image" && key === "image") {
      // A picture from the shared library (Settings → Images). Unlike
      // {{logo:custom}} — one image per layout — a layout can place any
      // number of these, which is the whole reason the library exists.
      //
      // Sizing: bare prints at the font-derived height, like a cert mark, so
      // it sits on a text line without thought. {{image:x:40}} instead sets
      // the WIDTH to 40% of the block (height auto) for artwork that has to
      // hit a size on the box — the same choice {{logo:custom}} makes via
      // its per-layout width setting, moved into the token because a layout
      // now carries several images that need different widths.
      const resolved = arg && ctx.images ? findLayoutImage(ctx.images, arg) : null;
      if (resolved?.dataUrl) {
        const pct = m[3] ? Number(m[3]) : null;
        const alt = escapeHtml(resolved.name);
        html +=
          pct && Number.isFinite(pct)
            ? `<span class="ol-img ol-img-w" style="width: ${pct}%"><img src="${resolved.dataUrl}" alt="${alt}" title="${alt}" /></span>`
            : `<span class="ol-img"><img src="${resolved.dataUrl}" alt="${alt}" title="${alt}" /></span>`;
      } else {
        // No such slug, the row is deactivated, or it has no artwork yet.
        // All three are the same thing to the operator — the picture the
        // layout asks for isn't there — so all three get the visible
        // `missing` chip that countPlaceholderMarkers() blocks approval on,
        // rather than a silently blank spot on the print.
        html += `<span class="missing">image:${escapeHtml(arg ?? "")} — no artwork in Settings → Images</span>`;
      }
      hadValue = true;
      continue;
    }

    if (meta.kind === "image") {
      const source = (arg ?? "contrast") as LogoSource;
      const dataUrl = ctx.logos[source];
      if (dataUrl) {
        // Custom logo sizes by WIDTH (% of its block; height auto). Contrast
        // keeps the font-scaled height (--ol-logo).
        if (source === "custom") {
          const pct = ctx.customLogoWidthPct;
          html += `<span class="ol-logo ol-logo-custom" style="width: ${pct}%"><img src="${dataUrl}" alt="custom logo" /></span>`;
        } else {
          html += `<span class="ol-logo"><img src="${dataUrl}" alt="${escapeHtml(source)} logo" /></span>`;
        }
        hadValue = true;
      } else {
        const hint =
          source === "custom"
            ? "No custom logo — upload one for this layout in the Output Builder"
            : source === "contrastAddress"
              ? "Contrast (address) logo missing — add public/logos/contrast-address.svg"
              : "Contrast logo missing — add public/logos/contrast.svg";
        html += `<span class="missing">${escapeHtml(hint)}</span>`;
        hadValue = true; // visible authoring gap, counted by the ship-gate
      }
      continue;
    }

    if (meta.kind === "symbols") {
      const rendered = renderWashSymbolsHtml(style, ctx, arg);
      html += rendered;
      if (rendered) hadValue = true;
      continue;
    }

    // Assortment table — a real <table>, sizes across the top and the
    // ratio underneath, so a style prospect shows the pack at a glance.
    // Drawn here rather than via the text resolver for the same reason
    // sizeRangeCoop is: the markup has to survive escaping.
    if (meta.kind === "table" && key === "assortmentTable") {
      const rendered = renderAssortmentTableHtml(style, arg === TABLE_TOTAL_ARG);
      if (rendered) {
        html += rendered;
        hadValue = true;
      } else if (ctx.mode === "preview") {
        // No readable ratio for this style — the same amber chip an empty
        // text token gets, so the operator sees a data gap, not a bug.
        html += `<span class="ol-miss">assortmentTable?</span>`;
      }
      continue;
    }

    // Coop size range: every size joined " - ", with the CURRENT
    // repetition's size (style.sizes[0], narrowed by repetitionStyles)
    // enlarged. Drawn here rather than via the text resolver so the
    // highlight markup survives escaping.
    //
    // The optional form argument (:numeric / :year) prints one half of a
    // two-form label — "86-92 cm / 1½-2 år" as either the centimetres or
    // the age. The highlight still keys off the RAW label, so narrowing
    // two sizes onto the same text enlarges that entry for both of them.
    if (key === "sizeRangeCoop") {
      const all = (style.allSizes ?? style.sizes).map((x) => x.label).filter(Boolean);
      if (all.length > 0) {
        const current = style.sizes[0]?.label ?? "";
        html += sizeFormEntries(all, parseSizeForm(arg))
          .map((entry) =>
            entry.labels.includes(current)
              ? `<span class="ol-size-current">${escapeHtml(entry.text)}</span>`
              : escapeHtml(entry.text),
          )
          .join(" - ");
        hadValue = true;
      } else if (ctx.mode === "preview") {
        html += `<span class="ol-miss">sizeRangeCoop?</span>`;
      }
      continue;
    }

    const value = resolveTextToken(style, key, arg);
    if (value) {
      html += escapeHtml(value);
      hadValue = true;
    } else if (ctx.mode === "preview") {
      html += `<span class="ol-miss">${escapeHtml(key + (arg ? `:${arg}` : ""))}?</span>`;
    }
    // production + empty → nothing
  }

  const rest = line.slice(lastIndex);
  literal += rest;
  html += escapeHtml(rest);

  // Drop token-only lines whose tokens all came up empty (production).
  if (ctx.mode === "production" && hadToken && !hadValue && !literal.trim()) return null;
  return applyInlineMarkdown(html);
}

// The assortment table: one column per size with the ratio beneath, plus a
// leading label column. Returns "" when the style has no readable ratio, so
// the caller can drop the line (production) or chip it (preview).
//
// Sizes with no value still get a column — the header must stay aligned
// with the style's real size run, and a visibly empty cell is the honest
// rendering of "the buyer didn't give this size a ratio".
//
// {{assortmentTable:total}} adds ONE trailing column: the pack's total in
// the bottom-right corner, on the qty row, under an empty corner header.
// It sums exactly the numbers the qty row prints, so the table always adds
// up for whoever reads it. A ratio that totals nothing drops the column
// rather than printing "0 PCS".
function renderAssortmentTableHtml(style: StyleData, withTotal: boolean): string {
  const entries = sizeRatioEntries(style);
  if (entries.length === 0) return "";

  const head = entries.map((e) => `<th>${escapeHtml(e.size)}</th>`).join("");
  const body = entries.map((e) => `<td>${escapeHtml(e.qty)}</td>`).join("");
  const total = withTotal ? formatSizeRatioTotal(entries) : "";
  return (
    `<table class="ol-assort">` +
    `<tr><th class="ol-assort-lbl">Size</th>${head}` +
    (total ? `<th class="ol-assort-total"></th>` : "") +
    `</tr>` +
    `<tr><th class="ol-assort-lbl">Qty</th>${body}` +
    (total ? `<td class="ol-assort-total">${escapeHtml(total)}</td>` : "") +
    `</tr>` +
    `</table>`
  );
}

// Very small inline formatting vocabulary: **bold** and _italic_
// (underscores only match when not embedded in a word, so values like
// "ART_NO_22" stay untouched). Applied to the assembled line HTML —
// literals are already escaped, so the only tags introduced are ours.
function applyInlineMarkdown(html: string): string {
  return html
    .replace(/\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/g, "<b>$1</b>")
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<i>$1</i>");
}

function blockBorder(block: LayoutBlock, fontScale: number): string {
  if (!block.border) return "";
  // Inner padding keeps text off the border. box-sizing is border-box
  // (base.ts), so it insets the content within the block's set size rather
  // than growing the box past its grid cell. Per-side via effectiveBorderPad
  // (the legacy single padMm degrades to equal sides).
  const p = effectiveBorderPad(block.border);
  const mm = (v: number) => (v * fontScale).toFixed(3);
  const pad =
    p.topMm || p.rightMm || p.bottomMm || p.leftMm
      ? `padding: ${mm(p.topMm)}mm ${mm(p.rightMm)}mm ${mm(p.bottomMm)}mm ${mm(p.leftMm)}mm; `
      : "";
  const rule = `${(block.border.widthMm * fontScale).toFixed(3)}mm solid ${block.border.color}`;
  return `${borderRuleCss(rule, effectiveBorderSides(block.border))} ${pad}`;
}

// The CSS for a rule on some subset of a box's edges. All four ⇒ the plain
// `border:` shorthand, so every framed field and every page frame already in
// the field renders the exact same HTML it did before sides existed. Fewer ⇒
// only the edges that print get a declaration; `.ol-block` and
// `.ol-page-border` set no border of their own, so the rest stay absent
// (CSS's initial border-style is `none`) rather than needing to be cleared.
function borderRuleCss(rule: string, sides: BorderSides): string {
  if (isFullBorder(sides)) return `border: ${rule};`;
  return (["top", "right", "bottom", "left"] as const)
    .filter((s) => sides[s])
    .map((s) => `border-${s}: ${rule};`)
    .join(" ");
}

// Inverted block colours, inlined per block. Both sides are schema-validated
// hex, so they're safe to drop straight into the style attribute. An invert
// with no authored colours resolves to the historic #000/#fff (invertColors),
// which is what the .ol-binvert class rule paints anyway — the inline pair
// simply lets each block carry its own.
function blockInvert(block: LayoutBlock): string {
  if (!block.invert) return "";
  const { bg, text } = invertColors(block);
  return `background: ${bg}; color: ${text}; `;
}

function blockTypography(block: LayoutBlock, fontScale: number): string {
  // Graphics scale with the block's font size: 9 pt is the classic size
  // (16 mm bars / 10 pt digits / 6 mm symbols). fontScale shrinks the whole
  // lot together when an info-area size override resizes the page.
  const pt = block.fontPt * fontScale;
  const bcH = ((pt * 16) / 9).toFixed(2);
  const bcNum = ((pt * 10) / 9).toFixed(2);
  const sym = ((pt * 6) / 9).toFixed(2);
  const logo = ((pt * 10) / 9).toFixed(2);
  return (
    `font-size: ${pt.toFixed(2)}pt; ` +
    `line-height: ${block.lineHeight}; ` +
    `font-weight: ${block.bold ? 700 : 400}; ` +
    `--ol-bc-h: ${bcH}mm; --ol-bc-num: ${bcNum}pt; --ol-sym: ${sym}mm; --ol-logo: ${logo}mm; --ol-cert: ${logo}mm; `
  );
}

// A rendered block plus whether it actually put anything on the sheet for
// this style — the input to the page's "omit when empty" decision. `hasInk`
// is false for a block whose every line resolved to nothing (renderLine
// dropped it) and for authored blank lines, which render as whitespace.
// Chrome the block carries regardless of content — its border, the page
// frame, sewing/fold guides — deliberately does NOT count: a bordered but
// empty cert box is still an empty page.
type RenderedBlock = { html: string; hasInk: boolean };

function renderBlock(block: LayoutBlock, page: LayoutPage, style: StyleData, ctx: RenderCtx): RenderedBlock {
  const { cols: gridCols, rows: gridRows } = pageGrid(page);
  const marg = page.margins ?? { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 };
  // Physical content width of this block (page is already the FINAL print
  // size — a sizeOverrideMm rewrite happened in prepareLayoutRender), minus
  // border + inner padding (box-sizing: border-box). Fixed-size barcodes
  // fit their magnification to this.
  const outerW = block.rect
    ? ((page.widthMm - marg.leftMm - marg.rightMm) * block.rect.colSpan) / gridCols
    : (page.widthMm * block.cols) / gridCols;
  // Only the VERTICAL rules that actually print eat content width — a
  // bottom-only rule costs nothing horizontally. All four sides on ⇒ 2 ×
  // width, exactly as before.
  const borderSides = effectiveBorderSides(block.border);
  const borderPad = block.border
    ? (block.border.widthMm * ((borderSides.left ? 1 : 0) + (borderSides.right ? 1 : 0)) +
        effectiveBorderPad(block.border).leftMm +
        effectiveBorderPad(block.border).rightMm) *
      ctx.fontScale
    : 0;
  const blockWidthMm = Math.max(0, outerW - borderPad);

  // A reviewer line override replaces the AUTHORED source line before
  // conditionals and tokens run — so an override resolves exactly as an
  // authored line would (plain text passes through; a token inside it still
  // resolves). This is the single place any text on any document can be
  // rewritten, which is what makes hardcoded literals correctable at all.
  const rendered = block.lines
    .map((line, i) => {
      const override =
        ctx.lineOverrides && block.id
          ? ctx.lineOverrides[lineOverrideKey(page.id, block.id, i)]
          : undefined;
      return renderLine(
        applyConditionalsForStyle(override ?? line, style),
        style,
        ctx,
        blockWidthMm,
      );
    })
    .filter((l): l is string => l !== null);
  const hasInk = rendered.some((l) => l.trim() !== "");
  const lines = rendered.map((l) => `<div class="ol-line">${l || "&nbsp;"}</div>`).join("");

  if (block.rect) {
    const r = block.rect;
    const m = marg;
    const innerW = page.widthMm - m.leftMm - m.rightMm;
    const innerH = page.heightMm - m.topMm - m.bottomMm;
    const left = (m.leftMm + (innerW * r.col) / gridCols).toFixed(2);
    const top = (m.topMm + (innerH * r.row) / gridRows).toFixed(2);
    const width = ((innerW * r.colSpan) / gridCols).toFixed(2);
    const height = ((innerH * r.rowSpan) / gridRows).toFixed(2);
    const justify =
      block.valign === "middle" ? "center" : block.valign === "bottom" ? "flex-end" : "flex-start";
    const styleAttr =
      `left: ${left}mm; top: ${top}mm; width: ${width}mm; height: ${height}mm; ` +
      `display: flex; flex-direction: column; justify-content: ${justify}; ` +
      `text-align: ${block.align ?? "left"}; ` +
      blockBorder(block, ctx.fontScale) +
      blockInvert(block) +
      blockTypography(block, ctx.fontScale);
    return {
      html: `<div class="ol-block ol-rect${block.invert ? " ol-binvert" : ""}${block.fitWidth ? " ol-fit" : ""}${block.fitHeight ? " ol-fith" : ""}" style="${styleAttr}">${lines}</div>`,
      hasInk,
    };
  }

  const anchor = block.anchor ?? "top-left";
  const widthMm = (page.widthMm * block.cols) / gridCols;
  const styleAttr =
    `width: ${widthMm.toFixed(2)}mm; ` +
    `text-align: ${block.align ?? ANCHOR_ALIGN[anchor]}; ` +
    blockBorder(block, ctx.fontScale) +
    blockInvert(block) +
    blockTypography(block, ctx.fontScale) +
    ANCHOR_CSS[anchor];
  return {
    html: `<div class="ol-block ol-${anchor}${block.invert ? " ol-binvert" : ""}${block.fitWidth ? " ol-fit" : ""}${block.fitHeight ? " ol-fith" : ""}" style="${styleAttr}">${lines}</div>`,
    hasInk,
  };
}

type PreparedLayoutRender = {
  pages: LayoutPage[];
  repStyles: StyleData[];
  ctx: RenderCtx;
  barcodeFont: StyleData["barcodeFont"];
};

// Shared setup for the single-document and serial (carton-numbered)
// renderers: page selection, language-token augmentation, repeat
// narrowing, and the async asset caches. The barcode cache is keyed by
// source:value and a carton serial never changes a barcode value, so it
// is built ONCE here and reused across every numbered copy.
async function prepareLayoutRender(
  def: LayoutDef,
  styleInput: StyleData,
  opts: LayoutRenderOptions,
): Promise<PreparedLayoutRender> {
  let style = styleInput;
  const mode = opts.mode ?? "production";
  const selectedPages =
    opts.pageIndex !== undefined
      ? def.pages.slice(opts.pageIndex, opts.pageIndex + 1)
      : def.pages;
  if (selectedPages.length === 0) {
    throw new Error(`layout has no page at index ${opts.pageIndex}`);
  }

  // Info-area size override — rewrite every page to the chosen mm size.
  // Clamped to the LayoutPage bounds (5–1000 mm) so a stray value can't
  // produce an invalid @page rule; grid blocks rescale automatically.
  const pages = opts.sizeOverrideMm
    ? selectedPages.map((p) => ({
        ...p,
        widthMm: clampMm(opts.sizeOverrideMm!.widthMm),
        heightMm: clampMm(opts.sizeOverrideMm!.heightMm),
      }))
    : selectedPages;

  // Uniform font/graphic scale: grid-relative positions already follow the
  // new page size, but font pt, barcode/symbol/logo sizes, borders and pad
  // are absolute — without this they'd stay full-size on a shrunk sticker and
  // overflow (clipped by .ol-page's overflow:hidden). Scale by the SMALLER of
  // the width/height ratios (authored size → chosen size) so the design fits
  // the more-constrained axis rather than spilling over. Proportional resizes
  // (the common case) have equal ratios, so it's a clean uniform zoom.
  let fontScale = 1;
  if (opts.sizeOverrideMm) {
    const ref = selectedPages[0];
    const sx = clampMm(opts.sizeOverrideMm.widthMm) / ref.widthMm;
    const sy = clampMm(opts.sizeOverrideMm.heightMm) / ref.heightMm;
    if (Number.isFinite(sx) && Number.isFinite(sy) && sx > 0 && sy > 0) {
      fontScale = Math.min(sx, sy);
    }
  }

  // Resolve language-derived tokens through the translation bank before
  // anything renders (idempotent — values already present are kept):
  // {{composition:<lang>}}, {{careInstructions:<lang>}} (standard
  // catalogue filtered by the style's wash icons), {{madeIn:<lang>}},
  // {{madeInLabel:<lang>}}, {{country:<lang>}},
  // {{countryOfOriginLabel:<lang>}}, {{manufacturer:<lang>}}.
  const compLangs = compositionLangsInDef(def);
  if (compLangs.length > 0) {
    style = await augmentCompositionTranslations(style, compLangs);
  }
  style = await augmentTranslatedFields(style, {
    care: langArgsInDef(def, "careInstructions"),
    madeIn: langArgsInDef(def, "madeIn"),
    madeInLabel: langArgsInDef(def, "madeInLabel"),
    country: langArgsInDef(def, "country"),
    countryOfOriginLabel: langArgsInDef(def, "countryOfOriginLabel"),
    manufacturer: langArgsInDef(def, "manufacturer"),
  });

  // Repeat-per-EAN: the whole (filtered) page set renders once per size
  // row, with style.sizes narrowed to the current row — {{size}},
  // {{ean13}} and {{barcode:ean13}} resolve per repetition. A style with
  // no sizes renders once (honest gaps where the EAN should be).
  const settings = layoutSettings(def);
  const repStyles: StyleData[] = repetitionStyles(style, settings.repeatBy);

  const usesLogo = defUsesToken(pages, "logo");
  // The image library is loaded only when the definition places one, and
  // skipped entirely when the caller already handed us the map.
  const needsImages = opts.layoutImages === undefined && defUsesToken(pages, "image");
  const [barcodes, symbols, contrastLogo, contrastAddressLogo, certs, loadedImages] = await Promise.all([
    buildBarcodeCache(repStyles, pages),
    defUsesToken(pages, "washSymbols") ? loadWashcareSymbols() : Promise.resolve(null),
    usesLogo ? getContrastLogoDataUrl() : Promise.resolve(null),
    usesLogo ? getContrastAddressLogoDataUrl() : Promise.resolve(null),
    printsDeclaredCert(pages, repStyles) ? loadCertificates() : Promise.resolve(null),
    needsImages ? loadLayoutImages() : Promise.resolve(null),
  ]);
  // The custom logo is per layout — supplied by the caller, not loaded here.
  const customLogo = opts.customLogo ?? null;
  const ctx: RenderCtx = {
    mode,
    barcodes,
    symbols,
    logos: { contrast: contrastLogo, contrastAddress: contrastAddressLogo, custom: customLogo },
    certs,
    images: opts.layoutImages ?? loadedImages,
    fontScale,
    customLogoWidthPct: settings.customLogoWidthPct,
    lineOverrides: opts.lineOverrides,
  };

  return { pages, repStyles, ctx, barcodeFont: style.barcodeFont };
}

// Fit scripts — pure CSS can't size a font to its content, so we measure in
// the page and set font-size. Exposed as window.__olFitWidth (kept name for
// renderPdf) which runs WIDTH-fit then HEIGHT-fit; both also self-run on load
// and on fonts.ready for the (script-enabled, un-sandboxed) preview iframe.
//
//   • Width  (.ol-fit)  — scale every line so it fills the line width on ONE
//     line, regardless of character count (scales up AND down). Per line: the
//     content width (Range) vs the line's clientWidth (which already accounts
//     for the block's border padding), set font-size by the ratio, one
//     correction pass for font-metric non-linearity. Blank lines skipped.
//   • Height (.ol-fith) — when a block's content is TALLER than its cell,
//     scale the block font DOWN until it fits — never up, so an in-bounds
//     block keeps its authored size. Content height is summed from the line
//     boxes (alignment-independent — valign middle/bottom would defeat
//     scrollHeight); available height is clientHeight minus vertical padding.
//     Iterated (padding is constant, so the shrink is slightly non-linear)
//     with a floor of 1 px. Stops a long {{careInstructions}} block from
//     overflowing onto the wash-symbols block below it.
const FIT_SCRIPT = `<script>
(function () {
  function fitLine(el) {
    if (!el.textContent || !el.textContent.trim()) return;
    var avail = el.clientWidth;
    if (!avail || avail <= 0) return;
    var range = document.createRange();
    function measure() { range.selectNodeContents(el); return range.getBoundingClientRect().width; }
    var w = measure();
    if (!w) return;
    var size = (parseFloat(getComputedStyle(el).fontSize) || 12) * (avail / w);
    if (size < 1) size = 1;
    if (size > 1000) size = 1000;
    el.style.fontSize = size + "px";
    var w2 = measure();
    if (w2 > avail && w2 > 0) {
      size = size * (avail / w2);
      if (size < 1) size = 1;
      el.style.fontSize = size + "px";
    }
  }
  function contentHeight(el) {
    var ch = el.children, h = 0;
    for (var i = 0; i < ch.length; i++) h += ch[i].getBoundingClientRect().height;
    return h;
  }
  function fitBlockHeight(el) {
    var cs = getComputedStyle(el);
    var padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var avail = el.clientHeight - padV;
    if (avail <= 0) return;
    for (var pass = 0; pass < 8; pass++) {
      var content = contentHeight(el);
      if (content <= avail + 0.5) break;
      var cur = parseFloat(getComputedStyle(el).fontSize) || 12;
      var next = cur * (avail / content);
      if (next < 1) next = 1;
      el.style.fontSize = next + "px";
      if (next <= 1) break;
    }
  }
  function fitAll() {
    var lines = document.querySelectorAll(".ol-fit .ol-line");
    for (var i = 0; i < lines.length; i++) fitLine(lines[i]);
    var blocks = document.querySelectorAll(".ol-fith");
    for (var j = 0; j < blocks.length; j++) fitBlockHeight(blocks[j]);
  }
  window.__olFitWidth = fitAll;
  fitAll();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
})();
</script>`;

// Print guides — non-content rules overlaid on the page (drawn after the
// blocks so they sit on top). Sewing lines are full-width long-dashed rules
// a fixed mm from the named edge (the seam allowance); the fold line is a
// fine-dashed rule through the centre — horizontal (across) or vertical
// (down). The two dash patterns differ so the lines are tellable apart.
// Guides carry no tokens and never count as placeholders, so they never
// block approval. The fold uses 50%, so it stays centred under the
// info-area size override; sewing offsets are absolute mm by design.
function renderGuides(page: LayoutPage): string {
  const parts: string[] = [];
  for (const s of page.sewingLines ?? []) {
    const pos = s.edge === "bottom" ? `bottom: ${s.offsetMm}mm;` : `top: ${s.offsetMm}mm;`;
    parts.push(`<div class="ol-guide ol-sew" style="${pos}"></div>`);
  }
  if (page.foldLine === "horizontal") {
    parts.push(`<div class="ol-guide ol-fold ol-fold-h"></div>`);
  } else if (page.foldLine === "vertical") {
    parts.push(`<div class="ol-guide ol-fold ol-fold-v"></div>`);
  }
  // Centre hang hole — a dashed circle where the punch goes, horizontally
  // centred (50%, so it stays centred under an info-area size override) with
  // its CENTRE offsetMm from the named edge. Absolute mm on the vertical, like
  // the sewing offsets: the hole is a physical die, not a scaled graphic.
  // Outline only — nothing is knocked out, so a design that prints through the
  // punch area still prints exactly as authored.
  const hole = page.centerHole;
  if (hole) {
    const pos = hole.edge === "bottom" ? "bottom" : "top";
    parts.push(
      `<div class="ol-guide ol-hole ol-hole-${pos}" style="${pos}: ${hole.offsetMm}mm; width: ${hole.diameterMm}mm; height: ${hole.diameterMm}mm;"></div>`,
    );
  }
  return parts.join("");
}

// Full-page frame (the "Page border" page setting) — one absolutely
// positioned box inset from the paper edge. Drawn BEFORE the blocks so a
// block that reaches the edge prints on top of it rather than under a rule.
// Colour/width are schema-validated (hex + mm bounds), so they're safe to
// inline. Absolute mm by design: the frame follows the paper, not the
// info-area font scale.
function renderPageBorder(page: LayoutPage): string {
  const b = page.pageBorder;
  if (!b) return "";
  // On a rounded page the frame curves WITH the die, tightening by its own
  // inset so the two stay concentric (a frame 2 mm inside a 5 mm corner is a
  // 3 mm corner). Square page ⇒ radius 0 ⇒ the rule is simply absent.
  const r = insetCornerRadiusMm(page.cornerRadiusMm, b.insetMm);
  const radius = r > 0 ? ` border-radius: ${r}mm;` : "";
  // A frame can be authored on a subset of edges (a rule along the bottom of
  // a carton marking, an L down one side). The box still spans the whole
  // page, so a partial frame stays put and stays concentric with a rounded
  // die — the missing edges simply aren't drawn.
  const rule = borderRuleCss(`${b.widthMm}mm solid ${b.color}`, effectiveBorderSides(b));
  return `<div class="ol-page-border" style="inset: ${b.insetMm}mm; ${rule}${radius}"></div>`;
}

// Lay a flat list of (page × style) units into the final HTML document.
// Each unit becomes one physical page with its own @page rule, so one
// document can carry differently-sized pages AND many numbered carton
// copies — Chromium renders the whole thing in a single pass.
//
// Blocks are rendered BEFORE the page list is fixed, because a page marked
// `omitWhenEmpty` only survives if it printed something for THIS style —
// see keptUnits.
function emitLayoutDocument(
  prep: PreparedLayoutRender,
  emitted: Array<{ page: LayoutPage; repStyle: StyleData }>,
  title: string,
): string {
  const { ctx } = prep;

  const rendered = emitted.map(({ page, repStyle }) => {
    const blocks = page.blocks.map((b) => renderBlock(b, page, repStyle, ctx));
    return {
      page,
      html: blocks.map((b) => b.html).join(""),
      hasInk: blocks.some((b) => b.hasInk),
    };
  });

  // Conditional pages: a page that opted into `omitWhenEmpty` and resolved
  // to nothing for this repetition row leaves the document entirely — the
  // certificate-page case (a page whose only content is {{cert:oekotex}}
  // would otherwise print as a blank sheet on every style that doesn't
  // declare the cert). Decided per (page × repetition row), so a per-EAN
  // repeat can drop the page from one row's file and keep it in another's.
  //
  // Production only: the builder preview must keep showing every page so
  // it stays editable (and there, a gated token renders an amber chip
  // rather than nothing, so the page isn't "empty" anyway).
  //
  // A document must never end up with zero pages — Chromium would still
  // emit one blank sheet, which is worse than the page we tried to drop —
  // so if everything would go, nothing does.
  const surviving =
    ctx.mode === "production" ? rendered.filter((u) => !(u.page.omitWhenEmpty && !u.hasInk)) : rendered;
  const keptUnits = surviving.length > 0 ? surviving : rendered;

  // Rounded corners are a property of the DIE, not the paper: the @page box
  // stays rectangular (the sheet is), while .ol-page carries the radius. With
  // the existing overflow:hidden that clips content to the rounded shape, so a
  // full-bleed block prints the curve the cutter makes.
  const pageCss = keptUnits
    .map(({ page: p }, i) => {
      const radius = p.cornerRadiusMm && p.cornerRadiusMm > 0 ? ` border-radius: ${p.cornerRadiusMm}mm;` : "";
      return `
  @page olp${i} { size: ${p.widthMm}mm ${p.heightMm}mm; margin: 0; }
  .ol-page-${i} { page: olp${i}; width: ${p.widthMm}mm; height: ${p.heightMm}mm;${radius} }`;
    })
    .join("");

  const pagesHtml = keptUnits
    .map(
      ({ page, html }, i) =>
        `<div class="ol-page ol-page-${i}">${renderPageBorder(page)}${html}${renderGuides(page)}</div>`,
    )
    .join("\n");
  // Append the fit-to-width script only when a block opts in.
  const usesFit = keptUnits.some(({ page }) => page.blocks.some((b) => b.fitWidth || b.fitHeight));
  const body = usesFit ? `${pagesHtml}\n${FIT_SCRIPT}` : pagesHtml;

  return htmlDocument({
    title,
    // Default @page size = the FIRST PRINTED page (not the first authored
    // one), so dropping a leading page doesn't leave the document defaulting
    // to a size nothing uses. Every page still carries its own named rule.
    pageSize: {
      kind: "mm",
      widthMm: keptUnits[0]?.page.widthMm ?? prep.pages[0].widthMm,
      heightMm: keptUnits[0]?.page.heightMm ?? prep.pages[0].heightMm,
    },
    body,
    barcodeFont: prep.barcodeFont,
    extraCss: `
  :root { --ol-pad: ${(2 * ctx.fontScale).toFixed(3)}mm; }
  .ol-page {
    position: relative;
    overflow: hidden;
    page-break-after: always;
    background: #fff;
  }
  .ol-page:last-child { page-break-after: auto; }
  ${pageCss}
  .ol-block { position: absolute; }
  /* Per-block invert — that block prints its text on a solid box. The colours
     are inlined per block (blockInvert); this rule is the black/white default
     they fall back to. A barcode inside keeps a white chip (dark bars +
     number) so it stays scannable whatever the box colour is. */
  .ol-block.ol-binvert { background: #000; color: #fff; }
  .ol-block.ol-binvert .ol-barcode { background: #fff; color: #000; padding: ${(1 * ctx.fontScale).toFixed(3)}mm; border-radius: 1mm; }
  .ol-page-border { position: absolute; pointer-events: none; z-index: 0; }
  .ol-guide { position: absolute; pointer-events: none; z-index: 5; }
  /* Dash patterns via gradients so sewing and fold read as distinct lines:
     sewing = long dashes (2.5/1.5 mm), fold = fine dashes (1/1 mm). */
  .ol-sew { left: 0; right: 0; height: 0.3mm; background: repeating-linear-gradient(to right, #111 0 2.5mm, transparent 2.5mm 4mm); }
  .ol-fold-h { left: 0; right: 0; top: 50%; height: 0.3mm; transform: translateY(-50%); background: repeating-linear-gradient(to right, #555 0 1mm, transparent 1mm 2mm); }
  .ol-fold-v { top: 0; bottom: 0; left: 50%; width: 0.3mm; transform: translateX(-50%); background: repeating-linear-gradient(to bottom, #555 0 1mm, transparent 1mm 2mm); }
  /* Centre hang hole — the die outline, dashed like the fold line. Size and
     vertical offset are inlined per page; the transform puts the CENTRE on
     that offset (and on the page's horizontal midline). */
  .ol-hole { left: 50%; border: 0.3mm dashed #555; border-radius: 50%; }
  .ol-hole-top { transform: translate(-50%, -50%); }
  .ol-hole-bottom { transform: translate(-50%, 50%); }
  /* flex-shrink:0 is load-bearing: .ol-block is a FIXED-height flex column
     (the drawn grid cell), so without it an over-full block shrinks each
     line's BOX toward min-height (1em) while the wrapped text inside still
     needs its full height — the text then spills out of its squashed box and
     lands on top of the line below, the stacked/illegible care text we kept
     hitting. Pinning lines to their natural height instead makes an over-full
     block overflow its frame VISIBLY (legible, clipped at the page edge) — an
     honest "this cell is too small" signal, not a scrambled label. */
  .ol-line { white-space: pre-wrap; word-break: break-word; min-height: 1em; flex-shrink: 0; }
  /* Fit-to-width: each line stays on one line; the fit script scales font. */
  .ol-fit .ol-line { white-space: nowrap; word-break: normal; }
  /* Coop size range: enlarge the current size within the dash-joined run. */
  .ol-size-current { font-size: 1.6em; font-weight: 700; }
  /* Assortment table — sizes across the top, ratio underneath. Sized in em
     so it follows the block's fontPt (and the fit scripts) like any other
     content. Hairline rules scale with fontScale so the grid stays crisp on
     a small label and doesn't turn heavy on a big prospect sheet. */
  /* auto (not fixed) layout so the leading Size/Qty column shrinks to its
     own text and the size columns take the rest — a fixed layout ignores
     the label column's width and lets a long size label ("3-9 Months")
     collide with it. */
  .ol-assort { border-collapse: collapse; width: 100%; table-layout: auto; margin: 0.2em 0; }
  .ol-assort th, .ol-assort td {
    border: ${(0.2 * ctx.fontScale).toFixed(3)}mm solid currentColor;
    padding: 0.15em 0.4em; text-align: center; word-break: break-word;
  }
  /* The size header row and the leading label column read as headings. */
  .ol-assort tr:first-child th { font-weight: 700; }
  .ol-assort-lbl { font-weight: 700; text-align: left; white-space: nowrap; width: 1%; }
  /* ":total" — the pack total in the bottom-right corner. Shrinks to its own
     text like the label column, so adding it never squeezes the size
     columns, and never wraps "12 PCS" onto two lines. */
  .ol-assort-total { font-weight: 700; white-space: nowrap; width: 1%; }
  .ol-barcode { display: inline-block; text-align: center; max-width: 100%; }
  .ol-barcode img { display: block; height: var(--ol-bc-h, 16mm); width: auto; max-width: 100%; margin-left: auto; margin-right: auto; }
  .ol-ean-number { margin-top: ${(1 * ctx.fontScale).toFixed(3)}mm; font-size: var(--ol-bc-num, 10pt); letter-spacing: 0.08em; }
  .ol-symbols { display: inline-flex; flex-wrap: wrap; gap: ${(1.5 * ctx.fontScale).toFixed(3)}mm; align-items: center; vertical-align: middle; }
  .ol-symbols img { width: var(--ol-sym, 6mm); height: var(--ol-sym, 6mm); object-fit: contain; }
  .ol-logo { display: inline-block; vertical-align: middle; max-width: 100%; }
  .ol-logo img { display: block; height: var(--ol-logo, 10mm); width: auto; max-width: 100%; }
  /* Custom logo: width set inline as a % of the block; height auto-scales.
     Must follow .ol-logo img so it wins on equal specificity. */
  .ol-logo-custom { max-width: 100%; }
  .ol-logo-custom img { width: 100%; height: auto; max-width: 100%; }
  .ol-cert { display: inline-block; vertical-align: middle; max-width: 100%; }
  .ol-cert img { display: block; height: var(--ol-cert, 10mm); width: auto; max-width: 100%; }
  /* Library images ({{image:<slug>}}): font-scaled height by default, so a
     bare token drops onto a text line like a cert mark. With a width % —
     {{image:x:40}} — width wins and the height follows the aspect ratio.
     The width rules must follow the height ones to win on equal specificity. */
  .ol-img { display: inline-block; vertical-align: middle; max-width: 100%; }
  .ol-img img { display: block; height: var(--ol-logo, 10mm); width: auto; max-width: 100%; }
  .ol-img-w { max-width: 100%; }
  .ol-img-w img { width: 100%; height: auto; max-width: 100%; }
  .cert-missing {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fef2f2; color: #b91c1c; border: 0.2mm dashed #ef4444;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
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

export async function renderLayoutHtml(
  def: LayoutDef,
  styleInput: StyleData,
  opts: LayoutRenderOptions = {},
): Promise<string> {
  const prep = await prepareLayoutRender(def, styleInput, opts);
  const emitted: Array<{ page: LayoutPage; repStyle: StyleData }> = [];
  for (const repStyle of prep.repStyles) {
    for (const page of prep.pages) emitted.push({ page, repStyle });
  }
  return emitLayoutDocument(prep, emitted, opts.title ?? "Output layout");
}

// MANUAL "X of Y" carton numbering: render the layout once per carton
// (no = 1…total) into a SINGLE document — total × (repeat × pages)
// physical pages — so the whole numbered set is produced by ONE Puppeteer
// render, not N. Each copy carries StyleData.cartonSerial so {{cartonNo}}
// / {{cartonTotal}} resolve to the running number. Standard generation
// never calls this; only the carton-prints endpoint does.
export async function renderLayoutHtmlSerial(
  def: LayoutDef,
  styleInput: StyleData,
  total: number,
  opts: LayoutRenderOptions = {},
): Promise<string> {
  const prep = await prepareLayoutRender(def, styleInput, opts);
  const emitted: Array<{ page: LayoutPage; repStyle: StyleData }> = [];
  for (let no = 1; no <= total; no++) {
    for (const base of prep.repStyles) {
      const repStyle: StyleData = { ...base, cartonSerial: { no, total } };
      for (const page of prep.pages) emitted.push({ page, repStyle });
    }
  }
  return emitLayoutDocument(prep, emitted, opts.title ?? "Output layout");
}

// Re-export for callers that pre-validate conditionals (publish route).
export { conditionalsInLine };

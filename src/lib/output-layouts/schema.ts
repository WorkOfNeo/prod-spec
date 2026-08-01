import { z } from "zod";

// =====================================================
// LayoutDef — the JSON artifact the Output Builder writes and
// renderLayoutHtml consumes. Two placement models per block:
//
//   • CORNER blocks (`anchor`) — pinned to one of the four corners,
//     growing inward, width in grid columns. The simple default.
//   • RECT blocks (`rect`) — a drawn cell rectangle on the
//     LAYOUT_GRID_COLS × LAYOUT_GRID_ROWS grid (col/row/colSpan/rowSpan),
//     with horizontal `align` and vertical `valign`. This is what makes
//     fully-centered squared designs possible.
//
// Content is plain text lines with {{token}} variables plus single-level
// conditionals:  {{if field == VALUE}}…{{else}}…{{endif}}
// Anything richer still belongs in a coded template
// (src/lib/pdf/templates/**), not here.
// =====================================================

// Legacy default grid — used for any page that doesn't carry an explicit
// gridCols/gridRows (every layout authored before the grid became
// configurable), so they keep rendering exactly as before.
export const LAYOUT_GRID_COLS = 12;
export const LAYOUT_GRID_ROWS = 12;

// Upper bound for a configurable per-page grid (a 4 mm cell on a ~480 mm page
// ≈ 120). Rect/anchor bounds use this; the live grid is gridCols/gridRows.
export const LAYOUT_GRID_MAX = 120;

// Default print-grid cell when generating a grid from the page size — the
// builder offers this as the starting cell and recomputes cols×rows from it.
export const DEFAULT_GRID_CELL_MM = 4;

// cols×rows for a page of these mm dimensions at the given square cell size,
// clamped to a sane range. round() so a 100 mm page at 4 mm ⇒ 25 columns.
export function gridFromCellMm(
  widthMm: number,
  heightMm: number,
  cellMm: number,
): { cols: number; rows: number } {
  const cell = cellMm > 0 ? cellMm : DEFAULT_GRID_CELL_MM;
  const clamp = (n: number) => Math.min(LAYOUT_GRID_MAX, Math.max(1, Math.round(n)));
  return { cols: clamp(widthMm / cell), rows: clamp(heightMm / cell) };
}

export const LAYOUT_ANCHORS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export const LayoutAnchorSchema = z.enum(LAYOUT_ANCHORS);
export type LayoutAnchor = z.infer<typeof LayoutAnchorSchema>;

// Bounds are the generous max grid; the real per-page limit (gridCols/
// gridRows) is enforced in LayoutPageSchema's superRefine, which has the
// page in scope.
export const LayoutRectSchema = z.object({
  col: z.number().int().min(0).max(LAYOUT_GRID_MAX - 1),
  row: z.number().int().min(0).max(LAYOUT_GRID_MAX - 1),
  colSpan: z.number().int().min(1).max(LAYOUT_GRID_MAX),
  rowSpan: z.number().int().min(1).max(LAYOUT_GRID_MAX),
});
export type LayoutRect = z.infer<typeof LayoutRectSchema>;

export const LayoutBlockSchema = z.object({
  // Stable identity within the page (selection, updates). Injected
  // deterministically by parseLayoutDef for defs written before ids.
  id: z.string().min(1).max(60).optional(),
  // Corner placement — exactly one of `anchor` / `rect` per block.
  anchor: LayoutAnchorSchema.optional(),
  // Grid-rect placement (drawn on the canvas).
  rect: LayoutRectSchema.optional(),
  // Width in grid columns — CORNER blocks only (rect blocks size by span).
  cols: z.number().int().min(1).max(LAYOUT_GRID_MAX).default(6),
  // Text alignment. Default: by anchor side for corner blocks; left for
  // rect blocks.
  align: z.enum(["left", "center", "right"]).optional(),
  // Vertical alignment within the rect — RECT blocks only.
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  // Optional box border around the block (solid), colour as hex.
  border: z
    .object({
      widthMm: z.number().min(0.1).max(5),
      color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "hex colour like #000 or #1a1a1a"),
      // Legacy single inner-padding value (mm) — one pad on every side.
      // Still accepted; parseLayoutDef migrates it into `pad` and the
      // renderer falls back to it (effectiveBorderPad), so old layouts
      // render unchanged.
      padMm: z.number().min(0).max(20).optional(),
      // Per-side inner padding (mm) between the border and the text — the
      // canonical shape, mirroring page `margins`. Edited in the builder
      // with a link/unlink toggle (linked = one value for all sides).
      // Resolve via effectiveBorderPad so an absent `pad` and the legacy
      // `padMm` both degrade cleanly. Scales with fontScale at render.
      pad: z
        .object({
          topMm: z.number().min(0).max(20).default(0),
          rightMm: z.number().min(0).max(20).default(0),
          bottomMm: z.number().min(0).max(20).default(0),
          leftMm: z.number().min(0).max(20).default(0),
        })
        .optional(),
    })
    .optional(),
  // Free font sizing: floor 1 pt (≈0.35 mm — below any real wash-care text)
  // and a generous 144 pt ceiling. The builder's NumberStepper accepts a
  // typed value and clamps to the same bounds, so the two never disagree.
  fontPt: z.number().min(1).max(144).default(9),
  bold: z.boolean().default(false),
  // Invert just THIS block: black background, white text (appearance only —
  // doesn't touch tokens or generation). A barcode inside keeps a white chip
  // so it stays scannable.
  invert: z.boolean().default(false),
  // Fit to width: render every line on ONE line, auto-scaling the font (up
  // or down) so it exactly fills the block width regardless of character
  // count. fontPt becomes the starting size; the renderer's fit script does
  // the scaling at render time (preview iframe + Puppeteer).
  fitWidth: z.boolean().default(false),
  // Shrink to fit height: when the block's content is TALLER than its cell,
  // scale the font DOWN until it fits — never up, so an in-bounds block keeps
  // its authored size. Stops a variable-length block ({{careInstructions}})
  // from overflowing its cell and colliding with the block below it. Same
  // render-time fit script as fitWidth (preview iframe + Puppeteer).
  fitHeight: z.boolean().default(false),
  lineHeight: z.number().min(1).max(3).default(1.4),
  lines: z.array(z.string().max(500)).max(100).default([]),
});
export type LayoutBlock = z.infer<typeof LayoutBlockSchema>;

// Per-side inner padding for a block border, resolved from the canonical
// `pad` if present, else the legacy single `padMm` expanded to all sides,
// else zero. The ONE place this fallback lives — shared by the renderer and
// the builder canvas/panel so they can never disagree (like pageGrid does
// for the grid default).
export function effectiveBorderPad(
  border: LayoutBlock["border"],
): { topMm: number; rightMm: number; bottomMm: number; leftMm: number } {
  if (border?.pad) return border.pad;
  const v = border?.padMm ?? 0;
  return { topMm: v, rightMm: v, bottomMm: v, leftMm: v };
}

// A printed sewing-line guide: a full-width horizontal rule a fixed
// distance from the top or bottom edge (the seam allowance). Fractional mm
// allowed (e.g. 7.5). Multiple per page.
export const SewingLineSchema = z.object({
  edge: z.enum(["top", "bottom"]).default("top"),
  offsetMm: z.number().min(0).max(1000).default(5),
});
export type SewingLine = z.infer<typeof SewingLineSchema>;

// Folding-line guide — always centred. "horizontal" = a rule across the
// vertical centre; "vertical" = a rule down the horizontal centre; "none"
// = off. Dashed at print time.
export const FoldLineSchema = z.enum(["none", "horizontal", "vertical"]);
export type FoldLine = z.infer<typeof FoldLineSchema>;

// Page border — a frame drawn around the WHOLE page, so a design doesn't
// need a dummy full-page block just to get an outline. Purely decorative:
// carries no tokens, consumes no grid cells, never blocks approval.
// `insetMm` pulls the frame in from the paper edge (0 = flush).
export const PageBorderSchema = z.object({
  widthMm: z.number().min(0.1).max(5).default(0.3),
  color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "hex colour like #000 or #1a1a1a")
    .default("#000000"),
  insetMm: z.number().min(0).max(50).default(0),
});
export type PageBorder = z.infer<typeof PageBorderSchema>;

export const LayoutPageSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().max(80).default(""),
    widthMm: z.number().min(5).max(1000),
    heightMm: z.number().min(5).max(1000),
    // Print guides — non-content rules drawn over the page (do not consume
    // grid cells, carry no tokens). See renderLayoutHtml's guide layer.
    sewingLines: z.array(SewingLineSchema).max(20).default([]),
    foldLine: FoldLineSchema.default("none"),
    // Optional frame around the whole page (absent = no border).
    pageBorder: PageBorderSchema.optional(),
    // Drop this page from the PRINTED document when nothing on it resolves
    // for the style being rendered. The case it exists for: a page whose
    // only content is a certification mark ({{cert:oekotex}}) — the mark
    // prints only on styles that declare the cert, so on every other style
    // that page would come out as a blank sheet. With this on, the page
    // simply isn't there; a 3-page care label becomes 2 pages.
    // Off by default, and deliberately opt-in per page: a blank page can
    // also be intentional (a plain back side), and those must keep printing
    // exactly as authored. See emitLayoutDocument in ./render.ts for what
    // counts as "empty" (guides and frames don't).
    omitWhenEmpty: z.boolean().default(false),
    // Per-page placement grid. Absent ⇒ the legacy 12×12 (see pageGrid),
    // so existing layouts are untouched. The builder generates these from a
    // cell size (e.g. 4 mm → 25×19 on a 100×75 page) and can regenerate.
    gridCols: z.number().int().min(1).max(LAYOUT_GRID_MAX).optional(),
    gridRows: z.number().int().min(1).max(LAYOUT_GRID_MAX).optional(),
    // Standard print inset: the grid maps to the page MINUS these margins.
    // Editable per side ("chained" editing — one value for all — is a UI
    // affordance over the same four fields).
    margins: z
      .object({
        topMm: z.number().min(0).max(50).default(0),
        rightMm: z.number().min(0).max(50).default(0),
        bottomMm: z.number().min(0).max(50).default(0),
        leftMm: z.number().min(0).max(50).default(0),
      })
      .default({ topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 }),
    // Legacy single-value margin (pre per-side) — migrated into `margins`
    // by parseLayoutDef and ignored afterwards.
    marginMm: z.number().min(0).max(50).optional(),
    // Generous runaway protection only — not a design constraint.
    blocks: z.array(LayoutBlockSchema).max(200).default([]),
  })
  .superRefine((page, ctx) => {
    const gridCols = page.gridCols ?? LAYOUT_GRID_COLS;
    const gridRows = page.gridRows ?? LAYOUT_GRID_ROWS;
    const seenAnchors = new Set<string>();
    for (const b of page.blocks) {
      if (!b.anchor && !b.rect) {
        ctx.addIssue({
          code: "custom",
          message: "block needs a corner anchor or a grid rect",
          path: ["blocks"],
        });
      }
      if (b.anchor && b.rect) {
        ctx.addIssue({
          code: "custom",
          message: "block can't have both an anchor and a rect",
          path: ["blocks"],
        });
      }
      if (b.anchor && !b.rect) {
        if (seenAnchors.has(b.anchor)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate block anchor "${b.anchor}" — one corner block per corner`,
            path: ["blocks"],
          });
        }
        seenAnchors.add(b.anchor);
      }
      if (b.rect) {
        if (b.rect.col + b.rect.colSpan > gridCols) {
          ctx.addIssue({ code: "custom", message: "rect overflows the grid horizontally", path: ["blocks"] });
        }
        if (b.rect.row + b.rect.rowSpan > gridRows) {
          ctx.addIssue({ code: "custom", message: "rect overflows the grid vertically", path: ["blocks"] });
        }
      }
    }
  });
export type LayoutPage = z.infer<typeof LayoutPageSchema>;

// The effective placement grid for a page — the stored gridCols/gridRows, or
// the legacy 12×12 when unset (back-compat). The ONE place this default is
// resolved, shared by the renderer and the builder so they never disagree.
export function pageGrid(page: { gridCols?: number; gridRows?: number }): { cols: number; rows: number } {
  return {
    cols: page.gridCols ?? LAYOUT_GRID_COLS,
    rows: page.gridRows ?? LAYOUT_GRID_ROWS,
  };
}

// One per-output generation rule ("generate only when…" / "never when…").
// Shape-mirrors OutputRule in src/lib/outputs/exclusion.ts — the engine that
// evaluates it — so this parse is the write-side guard for the very JSON the
// matcher reads. `field` is a synced ColumnMapping key (productGroup, …),
// validated as a non-empty string rather than an enum: a rule whose field is
// later dropped from the offered list must still round-trip through the editor
// instead of turning the whole layout definition invalid.
export const LayoutRuleSchema = z.object({
  field: z.string().min(1).max(60),
  op: z.enum(["contains", "equals"]).default("contains"),
  keywords: z.array(z.string().max(120)).max(50),
  mode: z.enum(["exclude", "include"]).default("exclude"),
});

// Per-layout output settings (the editor's "Settings" card).
export const LayoutSettingsSchema = z.object({
  // "ean": the whole layout repeats once per size/EAN row of the style —
  // within each repetition {{size}}, {{ean13}} and {{barcode:ean13}}
  // resolve to THAT row. "none": render once (default).
  // "size": one repetition per size row (deduped — one per size).
  // "ean":  one repetition per PO EAN row — SIZE × COLOUR combo, with
  //         {{size}}/{{ean13}}/{{colourName}} bound to that row.
  // "assort": one repetition per resolved ASSORTMENT (master) carton EAN —
  //         each row prints {{barcode:assortEan}} (also bound to
  //         {{barcode:cartonEan}}) and sets {{isAssortment}}. For the
  //         assortment sticker: one label for the whole mixed carton.
  // "cartonEan": one repetition per DISTINCT per-size CARTON EAN the style
  //         carries (carton.perSize), PLUS a final assortment-master row
  //         ({{isAssortment}}). Each row binds its carton onto {{cartonEan}} /
  //         {{barcode:cartonEan}} and narrows {{size}} to the covered size(s).
  //         For "one carton marking per carton": XS…XXL + Assort.
  repeatBy: z.enum(["none", "size", "ean", "assort", "cartonEan"]).default("none"),
  // How repetitions land in output FILES — independent of repeatBy, which
  // only controls how the content iterates. Meaningful when repeatBy ≠
  // "none" (a non-repeating layout is always one file):
  //   "ean":  one PDF per repetition row, each containing ONLY that row
  //           (every repetition row carries exactly one EAN, so this is
  //           the only per-something split that makes sense). Default —
  //           matches how repeat layouts have always shipped.
  //   "none": don't split — ONE PDF with every repetition back-to-back.
  splitBy: z.enum(["none", "ean"]).default("ean"),
  // Output file name expression (text tokens allowed), without ".pdf".
  // Empty → the runner's default "<styleNumber>-<variantKey>.pdf".
  fileName: z.string().max(160).default(""),
  // Eligible for MANUAL "X of Y" carton-numbered prints. Does NOT touch
  // standard generation (render/renderMany) — it only (a) reveals the
  // {{cartonNo}}/{{cartonTotal}} tokens in the builder, and (b) lets the
  // Style page offer the "Carton numbers…" action for this output. The
  // count is typed at print time; the carton-prints endpoint loops the
  // layout once per carton with StyleData.cartonSerial set.
  cartonNumbering: z.boolean().default(false),
  // Eligible for "Custom Carton Marking" — placing OTHER styles from the
  // SAME PO on the box ({{style2}}/{{style3}}… slots). INDEPENDENT of
  // cartonNumbering. Does NOT touch standard generation (which stays
  // single-style); it only (a) reveals the sibling tokens + {{multipleStyles}}
  // in the builder, and (b) lets the Style page's carton dialog offer the
  // sibling multiselect. A render goes multi-style ONLY on a one-off dialog
  // print that picks siblings (StyleData.multipleStyles).
  multipleStyles: z.boolean().default(false),
  // Print width of the {{logo:custom}} image as a % of its block's width;
  // height auto-scales to preserve aspect. The image itself is stored per
  // layout on OutputLayout.customLogo (uploaded in the builder).
  customLogoWidthPct: z.number().min(1).max(100).default(100),
  // WHETHER this output is generated for a style at all — the per-output
  // twin of the doc-type keyword rules (Output Builder → Document types).
  // "include": generate ONLY for styles that match (a barcode sticker that
  // exists just for shoes); "exclude": never generate for styles that match.
  // Evaluated by src/lib/outputs/exclusion.ts, exposed to the runner and the
  // readiness gate as TemplateVariant.generationRules. Empty = no gate: the
  // output generates for every style whose Prod Spec declares it, exactly as
  // before this setting existed.
  rules: z.array(LayoutRuleSchema).max(50).default([]),
});
export type LayoutSettings = z.infer<typeof LayoutSettingsSchema>;

export const LayoutDefSchema = z.object({
  pages: z.array(LayoutPageSchema).min(1).max(40),
  settings: LayoutSettingsSchema.optional(),
});
export type LayoutDef = z.infer<typeof LayoutDefSchema>;

// Does this layout bind a PER-ROW carton EAN? True for the repeats that
// rebind {{cartonEan}} per repetition row (repetitionStyles in ./render.ts);
// "none" / "size" / "assort" print the single style-level Style.cartonEan.
//
// The single source of truth for that distinction — TemplateVariant
// .perRowCartonEan (readiness) and the Output Builder's test-style picker
// both read it, so the picker can't label a style "missing Carton EAN" that
// readiness considers ready and the renderer prints fine.
export function hasPerRowCartonEan(settings: LayoutSettings): boolean {
  return settings.repeatBy === "ean" || settings.repeatBy === "cartonEan";
}

export function layoutSettings(def: LayoutDef): LayoutSettings {
  return (
    def.settings ?? {
      repeatBy: "none",
      splitBy: "ean",
      fileName: "",
      cartonNumbering: false,
      multipleStyles: false,
      customLogoWidthPct: 100,
      rules: [],
    }
  );
}

// Stable block identity even for defs saved before ids existed.
export function blockId(b: LayoutBlock): string {
  return b.id ?? (b.anchor ? `b-${b.anchor}` : "b-rect");
}

// Matches {{token}}, {{token:arg}} and {{token:arg:arg2}}. Group 1 = key,
// group 2 = arg, group 3 = arg2. arg2 is numeric-only (a size in mm — today
// only {{barcode:…:height}}), so a stray colon in a text arg can't grow a
// bogus second argument. Kept intentionally strict (no spaces, no nesting)
// so a stray "{{" in literal text can't half-match. Conditional control tags
// ({{if …}}, {{else}}, {{endif}}) deliberately do NOT match this — they're
// handled by IF_RE / CONTROL_RE below.
export const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9]*)(?::([a-zA-Z0-9-]+))?(?::([0-9]+(?:\.[0-9]+)?))?\}\}/g;

// Single-level conditional inside one line:
//   {{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}
//   {{if certificates includes FSC}}{{cert:fsc}}{{endif}}
// Value may be quoted. ==/!= compare the whole value, trimmed +
// case-insensitive; includes/!includes check the comma-separated list
// (per-item, punctuation-insensitive — see conditionMatches). No nesting.
export const IF_RE =
  /\{\{if\s+([a-zA-Z][a-zA-Z0-9]*)\s*(==|!=|!includes|includes)\s*"?([^"{}]*?)"?\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{endif\}\}/g;

// Control tags for canvas highlighting / orphan detection.
export const CONTROL_RE = /\{\{(if\b[^{}]*|else|endif)\}\}/g;

export type ConditionOp = "==" | "!=" | "includes" | "!includes";

export type LineConditional = {
  field: string;
  op: ConditionOp;
  value: string;
  ifBody: string;
  elseBody: string;
};

export function conditionalsInLine(line: string): LineConditional[] {
  const out: LineConditional[] = [];
  for (const m of line.matchAll(new RegExp(IF_RE.source, "g"))) {
    out.push({
      field: m[1],
      op: m[2] as ConditionOp,
      value: (m[3] ?? "").trim(),
      ifBody: m[4] ?? "",
      elseBody: m[5] ?? "",
    });
  }
  return out;
}

// Bare comparison key: lowercase alphanumerics only, so "OEKO-TEX",
// "OEKOTEX" and "oekotex" all agree. Mirrors normalizeCertKey in
// src/lib/pdf/certificates.ts (kept local — this file must stay
// client-safe, certificates.ts is server-only).
function bareToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function conditionMatches(actual: string, op: ConditionOp, value: string): boolean {
  if (op === "includes" || op === "!includes") {
    // List membership: true when one of the actual value's comma-separated
    // items equals VALUE (punctuation/case-insensitive). Built for list
    // fields ({{certificates}}: "FSC, OEKOTEX"); on a single-value field it
    // degrades to fuzzy whole-value equality — NOT substring matching, so
    // "GOT" never matches "GOTS".
    const want = bareToken(value);
    const has = want !== "" && actual.split(",").some((item) => bareToken(item) === want);
    return op === "includes" ? has : !has;
  }
  const a = actual.trim().toUpperCase();
  const v = value.trim().toUpperCase();
  return op === "==" ? a === v : a !== v;
}

// Evaluate every conditional in a line against `getValue(field)` and
// substitute the taken branch. Shared by the renderer (StyleData-backed)
// and readiness (mapped-column-backed) so they can never disagree.
export function applyConditionals(line: string, getValue: (field: string) => string): string {
  return line.replace(new RegExp(IF_RE.source, "g"), (...m) => {
    const [, field, op, value, ifBody, elseBody] = m as unknown as [
      string,
      string,
      ConditionOp,
      string | undefined,
      string | undefined,
      string | undefined,
    ];
    return conditionMatches(getValue(field), op, (value ?? "").trim())
      ? (ifBody ?? "")
      : (elseBody ?? "");
  });
}

// The line with conditional blocks REMOVED entirely — what remains is
// unconditionally rendered content (basis for static required columns).
export function lineWithoutConditionals(line: string): string {
  return line.replace(new RegExp(IF_RE.source, "g"), "");
}

export type TokenRef = { key: string; arg?: string; arg2?: string };

// Conditional control tags are NOT variables. {{if …}} carries spaces so it
// never matches TOKEN_RE, but bare {{else}} / {{endif}} are token-shaped and
// would otherwise be extracted as variables — and publish validation would
// reject them as "unknown variable {{else}}". They're handled entirely by
// IF_RE / validateLineConditionals, so exclude them here.
const CONTROL_TOKEN_KEYS = new Set(["if", "else", "endif"]);

export function tokensInLine(line: string): TokenRef[] {
  const out: TokenRef[] = [];
  for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
    if (CONTROL_TOKEN_KEYS.has(m[1])) continue;
    out.push({ key: m[1], arg: m[2] || undefined, arg2: m[3] || undefined });
  }
  return out;
}

// Every token reference in the whole definition (INCLUDING tokens inside
// conditional branches — used for palette/publish validation), deduped.
export function tokensInDef(def: LayoutDef): TokenRef[] {
  const seen = new Map<string, TokenRef>();
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const ref of tokensInLine(line)) {
          seen.set(`${ref.key}:${ref.arg ?? ""}:${ref.arg2 ?? ""}`, ref);
        }
      }
    }
  }
  return [...seen.values()];
}

export function conditionalsInDef(def: LayoutDef): LineConditional[] {
  const out: LineConditional[] = [];
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        out.push(...conditionalsInLine(line));
      }
    }
  }
  return out;
}

// Fresh single-page starter definition for a new layout. The grid is
// generated from the default 4 mm cell (100×75 mm ⇒ 25×19).
export function defaultLayoutDef(): LayoutDef {
  const grid = gridFromCellMm(100, 75, DEFAULT_GRID_CELL_MM);
  return {
    pages: [
      {
        id: "p1",
        title: "Page 1",
        widthMm: 100,
        heightMm: 75,
        margins: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 },
        sewingLines: [],
        foldLine: "none",
        omitWhenEmpty: false,
        gridCols: grid.cols,
        gridRows: grid.rows,
        blocks: [],
      },
    ],
  };
}

// Parse a stored definition; empty / legacy JSON falls back to the
// starter so old rows never crash the editor. Blocks written before ids
// existed get deterministic ones (so reparsing doesn't churn autosave).
export function parseLayoutDef(raw: unknown): LayoutDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultLayoutDef();
  if (!("pages" in (raw as object))) return defaultLayoutDef();
  const def = LayoutDefSchema.parse(raw);
  for (const page of def.pages) {
    // Legacy single-value margin → per-side (only when sides are unset).
    if (
      page.marginMm !== undefined &&
      page.marginMm > 0 &&
      page.margins.topMm === 0 &&
      page.margins.rightMm === 0 &&
      page.margins.bottomMm === 0 &&
      page.margins.leftMm === 0
    ) {
      const m = page.marginMm;
      page.margins = { topMm: m, rightMm: m, bottomMm: m, leftMm: m };
    }
    page.marginMm = undefined;
    page.blocks = page.blocks.map((b, i) => {
      const withId = {
        ...b,
        id: b.id ?? (b.anchor ? `b-${b.anchor}` : `b-r${i}`),
      };
      // Legacy single border padding → per-side `pad` (only when `pad` is
      // unset), then drop padMm so `pad` is canonical (mirrors marginMm).
      if (withId.border && withId.border.padMm !== undefined && !withId.border.pad) {
        const v = withId.border.padMm;
        withId.border = {
          ...withId.border,
          pad: { topMm: v, rightMm: v, bottomMm: v, leftMm: v },
          padMm: undefined,
        };
      }
      // Corner-anchor blocks are legacy (the editor is grid-only now) —
      // convert deterministically to an equivalent half-height rect:
      // left/right edge from the anchor side + block width; top/bottom
      // half with valign pinning content to the original edge.
      if (withId.anchor && !withId.rect) {
        const cols = withId.cols ?? 6;
        const left = withId.anchor.endsWith("left");
        const top = withId.anchor.startsWith("top");
        return {
          ...withId,
          anchor: undefined,
          rect: {
            col: left ? 0 : LAYOUT_GRID_COLS - cols,
            row: top ? 0 : Math.floor(LAYOUT_GRID_ROWS / 2),
            colSpan: cols,
            rowSpan: Math.floor(LAYOUT_GRID_ROWS / 2),
          },
          align: withId.align ?? (left ? "left" : "right"),
          valign: withId.valign ?? (top ? "top" : "bottom"),
        };
      }
      return withId;
    });
  }
  return def;
}

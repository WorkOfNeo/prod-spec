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

export const LAYOUT_GRID_COLS = 12;
export const LAYOUT_GRID_ROWS = 12;

export const LAYOUT_ANCHORS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export const LayoutAnchorSchema = z.enum(LAYOUT_ANCHORS);
export type LayoutAnchor = z.infer<typeof LayoutAnchorSchema>;

export const LayoutRectSchema = z.object({
  col: z.number().int().min(0).max(LAYOUT_GRID_COLS - 1),
  row: z.number().int().min(0).max(LAYOUT_GRID_ROWS - 1),
  colSpan: z.number().int().min(1).max(LAYOUT_GRID_COLS),
  rowSpan: z.number().int().min(1).max(LAYOUT_GRID_ROWS),
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
  cols: z.number().int().min(1).max(LAYOUT_GRID_COLS).default(6),
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
    })
    .optional(),
  fontPt: z.number().min(4).max(48).default(9),
  bold: z.boolean().default(false),
  lineHeight: z.number().min(1).max(3).default(1.4),
  lines: z.array(z.string().max(500)).max(100).default([]),
});
export type LayoutBlock = z.infer<typeof LayoutBlockSchema>;

export const LayoutPageSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().max(80).default(""),
    widthMm: z.number().min(5).max(1000),
    heightMm: z.number().min(5).max(1000),
    // Standard print inset: the 12×12 grid maps to the page MINUS these
    // margins. Editable per side ("chained" editing — one value for all —
    // is a UI affordance over the same four fields).
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
        if (b.rect.col + b.rect.colSpan > LAYOUT_GRID_COLS) {
          ctx.addIssue({ code: "custom", message: "rect overflows the grid horizontally", path: ["blocks"] });
        }
        if (b.rect.row + b.rect.rowSpan > LAYOUT_GRID_ROWS) {
          ctx.addIssue({ code: "custom", message: "rect overflows the grid vertically", path: ["blocks"] });
        }
      }
    }
  });
export type LayoutPage = z.infer<typeof LayoutPageSchema>;

// Per-layout output settings (the editor's "Settings" card).
export const LayoutSettingsSchema = z.object({
  // "ean": the whole layout repeats once per size/EAN row of the style —
  // within each repetition {{size}}, {{ean13}} and {{barcode:ean13}}
  // resolve to THAT row. "none": render once (default).
  // "size": one repetition per size row (deduped — one per size).
  // "ean":  one repetition per PO EAN row — SIZE × COLOUR combo, with
  //         {{size}}/{{ean13}}/{{colourName}} bound to that row.
  repeatBy: z.enum(["none", "size", "ean"]).default("none"),
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
});
export type LayoutSettings = z.infer<typeof LayoutSettingsSchema>;

export const LayoutDefSchema = z.object({
  pages: z.array(LayoutPageSchema).min(1).max(40),
  settings: LayoutSettingsSchema.optional(),
});
export type LayoutDef = z.infer<typeof LayoutDefSchema>;

export function layoutSettings(def: LayoutDef): LayoutSettings {
  return def.settings ?? { repeatBy: "none", splitBy: "ean", fileName: "" };
}

// Stable block identity even for defs saved before ids existed.
export function blockId(b: LayoutBlock): string {
  return b.id ?? (b.anchor ? `b-${b.anchor}` : "b-rect");
}

// Matches {{token}} and {{token:arg}}. Group 1 = key, group 2 = arg.
// Kept intentionally strict (no spaces, no nesting) so a stray "{{" in
// literal text can't half-match. Conditional control tags ({{if …}},
// {{else}}, {{endif}}) deliberately do NOT match this — they're handled
// by IF_RE / CONTROL_RE below.
export const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9]*)(?::([a-zA-Z0-9-]+))?\}\}/g;

// Single-level conditional inside one line:
//   {{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}
// Value may be quoted; comparison is trimmed + case-insensitive. No nesting.
export const IF_RE =
  /\{\{if\s+([a-zA-Z][a-zA-Z0-9]*)\s*(==|!=)\s*"?([^"{}]*?)"?\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{endif\}\}/g;

// Control tags for canvas highlighting / orphan detection.
export const CONTROL_RE = /\{\{(if\b[^{}]*|else|endif)\}\}/g;

export type LineConditional = {
  field: string;
  op: "==" | "!=";
  value: string;
  ifBody: string;
  elseBody: string;
};

export function conditionalsInLine(line: string): LineConditional[] {
  const out: LineConditional[] = [];
  for (const m of line.matchAll(new RegExp(IF_RE.source, "g"))) {
    out.push({
      field: m[1],
      op: m[2] as "==" | "!=",
      value: (m[3] ?? "").trim(),
      ifBody: m[4] ?? "",
      elseBody: m[5] ?? "",
    });
  }
  return out;
}

export function conditionMatches(actual: string, op: "==" | "!=", value: string): boolean {
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
      "==" | "!=",
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

export type TokenRef = { key: string; arg?: string };

export function tokensInLine(line: string): TokenRef[] {
  const out: TokenRef[] = [];
  for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
    out.push({ key: m[1], arg: m[2] || undefined });
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
          seen.set(`${ref.key}:${ref.arg ?? ""}`, ref);
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

// Fresh single-page starter definition for a new layout.
export function defaultLayoutDef(): LayoutDef {
  return {
    pages: [
      {
        id: "p1",
        title: "Page 1",
        widthMm: 100,
        heightMm: 75,
        margins: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 },
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

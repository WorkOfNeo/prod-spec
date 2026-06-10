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
  fontPt: z.number().min(4).max(48).default(9),
  bold: z.boolean().default(false),
  lineHeight: z.number().min(1).max(3).default(1.4),
  lines: z.array(z.string().max(500)).max(30).default([]),
});
export type LayoutBlock = z.infer<typeof LayoutBlockSchema>;

export const LayoutPageSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().max(80).default(""),
    widthMm: z.number().min(5).max(1000),
    heightMm: z.number().min(5).max(1000),
    blocks: z.array(LayoutBlockSchema).max(16).default([]),
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

export const LayoutDefSchema = z.object({
  pages: z.array(LayoutPageSchema).min(1).max(12),
});
export type LayoutDef = z.infer<typeof LayoutDefSchema>;

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
    page.blocks = page.blocks.map((b, i) => ({
      ...b,
      id: b.id ?? (b.anchor ? `b-${b.anchor}` : `b-r${i}`),
    }));
  }
  return def;
}

import { z } from "zod";

// =====================================================
// LayoutDef — the JSON artifact the Output Builder writes and
// renderLayoutHtml consumes. Deliberately constrained: pages with mm
// dimensions, and per page at most ONE text block per corner anchor.
// Blocks can't float freely — the only geometry is which corner, how
// many grid columns wide (of LAYOUT_GRID_COLS), and the type size.
// That constraint is what keeps every layout printable and the builder
// learnable; anything richer belongs in a coded template
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

export const LayoutBlockSchema = z.object({
  anchor: LayoutAnchorSchema,
  // Width in grid columns (of LAYOUT_GRID_COLS). Physical width is
  // cols / LAYOUT_GRID_COLS × page width.
  cols: z.number().int().min(1).max(LAYOUT_GRID_COLS).default(6),
  fontPt: z.number().min(4).max(48).default(9),
  bold: z.boolean().default(false),
  lineHeight: z.number().min(1).max(3).default(1.4),
  // One entry per printed row. Plain text with {{token}} /
  // {{token:arg}} variables — see src/lib/output-layouts/token-meta.ts.
  lines: z.array(z.string().max(500)).max(30).default([]),
});
export type LayoutBlock = z.infer<typeof LayoutBlockSchema>;

export const LayoutPageSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().max(80).default(""),
    widthMm: z.number().min(5).max(1000),
    heightMm: z.number().min(5).max(1000),
    blocks: z.array(LayoutBlockSchema).max(LAYOUT_ANCHORS.length).default([]),
  })
  .superRefine((page, ctx) => {
    const seen = new Set<string>();
    for (const b of page.blocks) {
      if (seen.has(b.anchor)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate block anchor "${b.anchor}" — one block per corner`,
          path: ["blocks"],
        });
      }
      seen.add(b.anchor);
    }
  });
export type LayoutPage = z.infer<typeof LayoutPageSchema>;

export const LayoutDefSchema = z.object({
  pages: z.array(LayoutPageSchema).min(1).max(12),
});
export type LayoutDef = z.infer<typeof LayoutDefSchema>;

// Matches {{token}} and {{token:arg}}. Group 1 = key, group 2 = arg.
// Kept intentionally strict (no spaces, no nesting) so a stray "{{" in
// literal text can't half-match.
export const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9]*)(?::([a-zA-Z0-9-]+))?\}\}/g;

export type TokenRef = { key: string; arg?: string };

export function tokensInLine(line: string): TokenRef[] {
  const out: TokenRef[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    out.push({ key: m[1], arg: m[2] || undefined });
  }
  return out;
}

// Every token reference in the whole definition, deduped by key:arg.
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
// starter so old rows never crash the editor.
export function parseLayoutDef(raw: unknown): LayoutDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultLayoutDef();
  if (!("pages" in (raw as object))) return defaultLayoutDef();
  return LayoutDefSchema.parse(raw);
}

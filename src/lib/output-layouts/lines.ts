import type { StyleData } from "@/lib/pdf/types";
import { TOKEN_RE, type LayoutDef } from "./schema";
import { applyConditionalsForStyle, blockShownForStyle, resolveTextToken } from "./tokens";
import { tokenMeta } from "./token-meta";
import { lineOverrideKey } from "./line-keys";

// =====================================================
// Enumerate the text lines of one rendered document, with what each one
// currently prints — the input to the review page's line editor.
//
// This is the READ side of output-line-values.ts. It walks the same
// (page → block → line) structure renderBlock walks, in the same order, so the
// list the reviewer sees matches the document top-to-bottom, and each row's
// `lineKey` is the exact key the renderer will look up.
//
// `resolved` is a PLAIN-TEXT approximation, not the renderer's HTML: text
// tokens resolve through the same resolveTextToken the renderer uses, while
// tokens that draw graphics (barcodes, wash-care symbols, logos, certificate
// marks, the assortment table) resolve to a bracketed marker. It exists to let
// a reviewer FIND the line they mean ("which one prints 8 pair?"), so fidelity
// on text is what matters; a barcode has no text to show.
// =====================================================

export type DocumentLineKind = "text" | "graphic";

export type DocumentLine = {
  lineKey: string;
  pageId: string;
  pageIndex: number;
  pageTitle: string;
  blockId: string;
  lineIndex: number;
  // The layout's OWN authored line — what clearing the override reverts to.
  authored: string;
  // What the editor's input holds: the override when set, else the authored line.
  source: string;
  // Plain-text resolution of `source` against this document's style.
  resolved: string;
  // "graphic" when the line hosts a barcode / symbols / logo / cert / table.
  // Editable like any other (the point is that everything is), but the UI warns
  // that replacing it prints text where a graphic used to be.
  kind: DocumentLineKind;
  overridden: boolean;
};

// Marker shown in place of a token that draws something rather than writing
// text. Bracketed so it can't be mistaken for content the layout prints.
function graphicMarker(key: string, arg: string | undefined): string {
  switch (tokenMeta(key)?.kind) {
    case "barcode":
      return `[barcode${arg ? `: ${arg}` : ""}]`;
    case "symbols":
      return "[wash-care symbols]";
    case "image":
      if (key === "cert") return `[certificate${arg ? `: ${arg}` : ""}]`;
      if (key === "image") return `[image${arg ? `: ${arg}` : ""}]`;
      return "[logo]";
    case "table":
      return "[assortment table]";
    default:
      return "";
  }
}

// Resolve one source line to plain text for THIS style. Conditionals are
// applied first (same as the renderer), so a line inside an untaken branch
// resolves to what actually prints. An empty token resolves to "" — the honest
// rendering of "this style has no value there".
export function resolveLinePlain(line: string, style: StyleData): string {
  const effective = applyConditionalsForStyle(line, style);
  return effective
    .replace(new RegExp(TOKEN_RE.source, "g"), (_m, key: string, arg?: string) => {
      const meta = tokenMeta(key);
      if (meta && meta.kind !== "text") return graphicMarker(key, arg);
      return resolveTextToken(style, key, arg);
    })
    .trim();
}

// Does this line host a non-text token?
function lineKind(line: string): DocumentLineKind {
  for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
    const meta = tokenMeta(m[1]);
    if (meta && meta.kind !== "text") return "graphic";
  }
  return "text";
}

// The layout's own authored text at a line address, or null when the layout no
// longer has that line (a block was deleted, or lines were removed above it —
// the positional index is the one soft spot of line addressing, see
// line-keys.ts). The "before" side of a reviewer's line edit.
export function authoredLineAt(def: LayoutDef, lineKey: string): string | null {
  const [pageId, blockId, idx] = lineKey.split("|");
  const block = def.pages.find((p) => p.id === pageId)?.blocks.find((b) => b.id === blockId);
  const line = block?.lines[Number(idx)];
  return line ?? null;
}

// Text tokens a line EDIT brought in that print nothing for this style — the
// silent failure of a hand edit. A reviewer who types "{{composition:da}} /
// {{composition:de}}" on a layout that only ever prints German gets a stray
// "/" on the label: the Danish composition was never translated for that
// layout, the token resolves to "", and nothing on the card says so.
//
// Only tokens the edit ADDED are reported. A token the layout's own line
// already had and that is empty here prints nothing with or without the edit —
// that is a data gap readiness already reports, not something the reviewer did.
// Graphic tokens (barcode, symbols, logo, cert, table) draw rather than write,
// so they are out of scope here. Conditionals apply first, so a token inside an
// untaken {{if}} branch is not reported.
export function emptyTokensAddedByEdit(edit: string, authored: string | null, style: StyleData): string[] {
  const out = new Set<string>();
  for (const m of applyConditionalsForStyle(edit, style).matchAll(new RegExp(TOKEN_RE.source, "g"))) {
    const token = m[0];
    if (authored?.includes(token)) continue;
    const meta = tokenMeta(m[1]);
    if (meta && meta.kind !== "text") continue;
    if (!resolveTextToken(style, m[1], m[2]).trim()) out.add(token);
  }
  return [...out];
}

// Every line of the document, in render order. Blank authored lines (layout
// spacers) are included — a reviewer can type into one to ADD a line the layout
// never had, which is part of "anything that might occur".
export function documentLines(
  def: LayoutDef,
  style: StyleData,
  overrides: Record<string, string> | undefined,
): DocumentLine[] {
  const out: DocumentLine[] = [];
  def.pages.forEach((page, pageIndex) => {
    for (const block of page.blocks) {
      // parseLayoutDef guarantees an id on every block; skip defensively rather
      // than mint an unstable address that would bind an edit to the wrong line.
      if (!block.id) continue;
      // A block whose "Show only when" rules fail doesn't print for this style,
      // so its lines aren't part of the document a reviewer can correct.
      if (!blockShownForStyle(block, style)) continue;
      block.lines.forEach((authored, lineIndex) => {
        const lineKey = lineOverrideKey(page.id, block.id!, lineIndex);
        const override = overrides?.[lineKey];
        const source = override ?? authored;
        out.push({
          lineKey,
          pageId: page.id,
          pageIndex,
          pageTitle: page.title || `Page ${pageIndex + 1}`,
          blockId: block.id!,
          lineIndex,
          authored,
          source,
          resolved: resolveLinePlain(source, style),
          kind: lineKind(source) === "graphic" || lineKind(authored) === "graphic" ? "graphic" : "text",
          overridden: override != null,
        });
      });
    }
  });
  return out;
}

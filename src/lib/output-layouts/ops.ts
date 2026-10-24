// =====================================================
// Layout edit operations — the ONLY way a change-request agent edits a
// layout definition, and the vocabulary the review screen and the learning
// signals describe edits in.
//
// Why a small op language instead of "send back the whole new definition":
//
//   • Reviewable. A draft is the live definition plus a short list of named
//     edits ("move block b-r3", "edit line 2"), so the reviewer — and
//     describeLayoutChanges — can say exactly what changed and nothing else
//     can slip in alongside it.
//   • Safe against stale reads. Blocks are addressed by their stable id (after
//     parseLayoutDef every block has one), and edit_line / remove_line must
//     quote the line they replace. If the layout moved on since the agent read
//     it, the op is rejected instead of clobbering someone else's edit.
//   • Independent. Each op is validated on its own and applied to a scratch
//     copy; a rejected op is reported with a reason and the rest still apply.
//     An agent gets precise feedback per op and can retry just that one.
//
// The checks are the publish gate's (validateTokenRef,
// validateLineConditionals, validateLineCalcs, LayoutDefSchema incl. the page
// grid bounds), run on every line an op writes, so a draft built from ops is
// publishable by construction. Overlaps and likely text overflow are only
// WARNINGS: the estimate below is deliberately rough (character count × font
// size) and the before/after proof render is the real fit check.
//
// Addressing: `page` is the 0-based index into def.pages and `line` the
// 0-based index into block.lines — the same positions get_layout shows.
// describeLayoutChanges' summaries are written for people, so they say
// "line 2" / "page 2" counting from 1.
//
// Pure and client-safe (schema / token-meta / calc only — no db, no server
// imports); the input definition is never mutated.
// =====================================================
import { z } from "zod";
import { CALC_RE, validateLineCalcs } from "./calc";
import {
  CONTROL_RE,
  IF_RE,
  LayoutBlockSchema,
  LayoutDefSchema,
  TOKEN_RE,
  effectiveBorderPad,
  effectiveBorderSides,
  layoutSettings,
  pageGrid,
  parseLayoutDef,
  tokensInLine,
  type LayoutBlock,
  type LayoutDef,
  type LayoutPage,
  type LayoutRect,
} from "./schema";
import { tokenMeta, validateLineConditionals, validateTokenRef } from "./token-meta";

// ---------------------------------------------------------------------
// The op union (zod, so agent JSON is checked at the boundary; the TS type
// is inferred from it so the two can't drift).
// ---------------------------------------------------------------------

export const LAYOUT_OP_KINDS = [
  "add_block",
  "remove_block",
  "set_rect",
  "set_block_props",
  "edit_line",
  "insert_line",
  "remove_line",
] as const;
export type LayoutOpKind = (typeof LAYOUT_OP_KINDS)[number];

// Shape only: integer cells. Bounds (≥ 0, inside THIS page's grid) are
// checked per op against the page, so the reason can name the real grid
// instead of zod's generic LAYOUT_GRID_MAX ceiling.
const RectShape = z.object({
  col: z.number().int(),
  row: z.number().int(),
  colSpan: z.number().int(),
  rowSpan: z.number().int(),
});

const Align = z.enum(["left", "center", "right"]);
const VAlign = z.enum(["top", "middle", "bottom"]);
const BorderSchema = LayoutBlockSchema.shape.border.unwrap();

// The props set_block_props may change. Strict: a stray "rect" or "lines"
// must be rejected, not silently dropped — those have their own ops.
export const SETTABLE_BLOCK_PROPS = [
  "fontPt",
  "bold",
  "align",
  "valign",
  "fitWidth",
  "fitHeight",
  "lineHeight",
  "invert",
  "border",
] as const;

const BlockPropsSchema = z.strictObject({
  fontPt: z.number().optional(),
  bold: z.boolean().optional(),
  align: Align.optional(),
  valign: VAlign.optional(),
  fitWidth: z.boolean().optional(),
  fitHeight: z.boolean().optional(),
  lineHeight: z.number().optional(),
  invert: z.boolean().optional(),
  // null removes the border (JSON has no `undefined`).
  border: BorderSchema.nullable().optional(),
});

// Strict for the same reason: add_block takes exactly these; anything else
// (border, invert…) is a set_block_props on the new block's id.
const NewBlockSchema = z.strictObject({
  id: z.string().optional(),
  rect: RectShape,
  lines: z.array(z.string()),
  fontPt: z.number().optional(),
  bold: z.boolean().optional(),
  align: Align.optional(),
  valign: VAlign.optional(),
  fitWidth: z.boolean().optional(),
  lineHeight: z.number().optional(),
});

const PageIndex = z.number().int();
const LineIndex = z.number().int();

export const LayoutOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_block"), page: PageIndex, block: NewBlockSchema }),
  z.object({ op: z.literal("remove_block"), page: PageIndex, blockId: z.string() }),
  z.object({ op: z.literal("set_rect"), page: PageIndex, blockId: z.string(), rect: RectShape }),
  z.object({ op: z.literal("set_block_props"), page: PageIndex, blockId: z.string(), props: BlockPropsSchema }),
  z.object({
    op: z.literal("edit_line"),
    page: PageIndex,
    blockId: z.string(),
    line: LineIndex,
    oldText: z.string(),
    newText: z.string(),
  }),
  z.object({ op: z.literal("insert_line"), page: PageIndex, blockId: z.string(), line: LineIndex, text: z.string() }),
  z.object({
    op: z.literal("remove_line"),
    page: PageIndex,
    blockId: z.string(),
    line: LineIndex,
    oldText: z.string(),
  }),
]);
export type LayoutOp = z.infer<typeof LayoutOpSchema>;
export type Rect = LayoutRect;

export type LayoutOpRejection = { op: LayoutOp; reason: string };
export type ApplyLayoutOpsResult = {
  def: LayoutDef;
  applied: LayoutOp[];
  rejected: LayoutOpRejection[];
  warnings: string[];
};

// Schema limits restated so a rejection can say them plainly (the final
// LayoutDefSchema pass still backs every one of them up).
const FONT_PT_MIN = 1;
const FONT_PT_MAX = 144;
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 3;
const MAX_LINE_CHARS = 500;
const MAX_LINES = 100;
const MAX_BLOCKS = 200;
const MAX_ID_CHARS = 60;
// The agent's own rail (design §5.7): printed label text never below 5 pt.
const MIN_PRINT_PT = 5;

// ---------------------------------------------------------------------
// Line validation — the publish gate's checks for one line, plus a catch for
// token-shaped text no regex recognises ({{ polybagQty }}, {{polybag_qty}}),
// which the renderer would otherwise print literally.
// ---------------------------------------------------------------------

export function validateLayoutLine(text: string): string[] {
  if (/[\r\n]/.test(text)) return ["a line can't contain a line break — use insert_line for another line"];
  if (text.length > MAX_LINE_CHARS) return [`a line can hold at most ${MAX_LINE_CHARS} characters (got ${text.length})`];
  const errs: string[] = [];
  for (const ref of tokensInLine(text)) errs.push(...validateTokenRef(ref.key, ref.arg, ref.arg2));
  errs.push(...validateLineConditionals(text, IF_RE, CONTROL_RE));
  errs.push(...validateLineCalcs(text));
  if (errs.length === 0) {
    const rest = text
      .replace(new RegExp(CALC_RE.source, "g"), "")
      .replace(new RegExp(CONTROL_RE.source, "g"), "")
      .replace(new RegExp(TOKEN_RE.source, "g"), "");
    if (rest.includes("{{") || rest.includes("}}")) {
      errs.push(
        'unrecognised "{{…}}" — a variable is written {{key}} or {{key:arg}} with no spaces, a condition {{if field == "value"}}…{{endif}}',
      );
    }
  }
  return [...new Set(errs)];
}

// ---------------------------------------------------------------------
// applyLayoutOps
// ---------------------------------------------------------------------

type OpOutcome =
  | { error: string }
  | {
      op: LayoutOp;
      pageIndex: number;
      blockId: string;
      // add_block / set_rect move the block — re-check overlaps.
      geometry: boolean;
      // remove_block — nothing left to warn about.
      removed?: boolean;
    };

export function applyLayoutOps(def: LayoutDef, ops: readonly LayoutOp[]): ApplyLayoutOpsResult {
  const list: readonly unknown[] = Array.isArray(ops) ? ops : [];
  let work: LayoutDef;
  try {
    work = parseLayoutDef(structuredClone(def));
  } catch (err) {
    const reason = `the current layout definition is invalid (${errorText(err)}), so no op can be applied`;
    return {
      def: structuredClone(def),
      applied: [],
      rejected: list.map((op) => ({ op: cloneOp(op), reason })),
      warnings: [],
    };
  }

  const applied: LayoutOp[] = [];
  const rejected: LayoutOpRejection[] = [];
  // `${pageIndex}|${blockId}` → whether its geometry changed. Insertion order
  // keeps the warnings in op order.
  const touched = new Map<string, { pageIndex: number; blockId: string; geometry: boolean }>();

  for (const raw of list) {
    const parsed = parseOp(raw);
    if ("error" in parsed) {
      rejected.push({ op: cloneOp(raw), reason: parsed.error });
      continue;
    }
    const next = structuredClone(work);
    const outcome = applyOne(next, parsed.op);
    if ("error" in outcome) {
      rejected.push({ op: cloneOp(raw), reason: outcome.error });
      continue;
    }
    // Backstop: whatever the per-op checks missed, the result must still be
    // a definition the builder, renderer and publish gate accept.
    const check = LayoutDefSchema.safeParse(next);
    if (!check.success) {
      rejected.push({
        op: cloneOp(raw),
        reason: `the result would not be a valid layout: ${issuesText(check.error.issues)}`,
      });
      continue;
    }
    work = next;
    applied.push(outcome.op);
    const key = `${outcome.pageIndex}|${outcome.blockId}`;
    if (outcome.removed) {
      touched.delete(key);
    } else {
      const prev = touched.get(key);
      touched.set(key, {
        pageIndex: outcome.pageIndex,
        blockId: outcome.blockId,
        geometry: (prev?.geometry ?? false) || outcome.geometry,
      });
    }
  }

  return { def: work, applied, rejected, warnings: collectWarnings(work, [...touched.values()]) };
}

// The parsed op, or a readable reason it isn't even the right shape —
// unknown op name, missing field, wrong type, a prop that has its own op.
function parseOp(raw: unknown): { op: LayoutOp } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: 'an op must be an object like { "op": "edit_line", … }' };
  }
  const kind = (raw as { op?: unknown }).op;
  if (typeof kind !== "string" || !(LAYOUT_OP_KINDS as readonly string[]).includes(kind)) {
    return { error: `unknown op ${JSON.stringify(kind ?? null)} — expected one of ${LAYOUT_OP_KINDS.join(", ")}` };
  }
  const parsed = LayoutOpSchema.safeParse(raw);
  if (parsed.success) return { op: parsed.data };
  let reason = `${kind}: ${issuesText(parsed.error.issues)}`;
  if (parsed.error.issues.some((i) => i.code === "unrecognized_keys")) {
    reason +=
      kind === "set_block_props"
        ? ` (set_block_props can change ${SETTABLE_BLOCK_PROPS.join(", ")}; use set_rect to move or resize and edit_line / insert_line / remove_line for text)`
        : kind === "add_block"
          ? " (add the block first, then change other props with set_block_props on its id)"
          : "";
  }
  return { error: reason };
}

function applyOne(def: LayoutDef, op: LayoutOp): OpOutcome {
  const pageRes = findPage(def, op.page);
  if ("error" in pageRes) return pageRes;
  const page = pageRes.page;

  if (op.op === "add_block") {
    const b = op.block;
    const rectErr = rectError(b.rect, page);
    if (rectErr) return { error: rectErr };
    if (b.lines.length === 0) return { error: "add_block needs at least one line of text" };
    if (b.lines.length > MAX_LINES) return { error: `a block can hold at most ${MAX_LINES} lines (got ${b.lines.length})` };
    for (const line of b.lines) {
      const err = lineError(line);
      if (err) return { error: err };
    }
    const numErr = numberPropsError(b);
    if (numErr) return { error: numErr };
    if (page.blocks.length >= MAX_BLOCKS) return { error: `page ${op.page} already has the maximum of ${MAX_BLOCKS} blocks` };
    const taken = new Set(page.blocks.map((x) => x.id));
    let id: string;
    if (b.id !== undefined) {
      id = b.id.trim();
      if (!id || id.length > MAX_ID_CHARS) return { error: `block id must be 1–${MAX_ID_CHARS} characters` };
      if (taken.has(id)) return { error: `block id "${id}" is already used on page ${op.page} — pick another or leave id out` };
    } else {
      // Deterministic: the same def + ops always yield the same id, so a
      // replayed patch (bench, revision history) lands on the same block.
      let n = 1;
      while (taken.has(`b-add${n}`)) n++;
      id = `b-add${n}`;
    }
    const parsed = LayoutBlockSchema.safeParse({
      id,
      rect: { ...b.rect },
      lines: [...b.lines],
      ...(b.fontPt !== undefined ? { fontPt: b.fontPt } : {}),
      ...(b.bold !== undefined ? { bold: b.bold } : {}),
      ...(b.align !== undefined ? { align: b.align } : {}),
      ...(b.valign !== undefined ? { valign: b.valign } : {}),
      ...(b.fitWidth !== undefined ? { fitWidth: b.fitWidth } : {}),
      ...(b.lineHeight !== undefined ? { lineHeight: b.lineHeight } : {}),
    });
    if (!parsed.success) return { error: `the new block is invalid: ${issuesText(parsed.error.issues)}` };
    page.blocks.push(parsed.data);
    // Report the id we chose, so the caller (and the stored revision ops)
    // can address the block in a follow-up op.
    return {
      op: { ...op, block: { ...b, id, rect: { ...b.rect }, lines: [...b.lines] } },
      pageIndex: op.page,
      blockId: id,
      geometry: true,
    };
  }

  const blockRes = findBlock(page, op.page, op.blockId);
  if ("error" in blockRes) return blockRes;
  const { index } = blockRes;
  const block = page.blocks[index];
  const done = (geometry: boolean, removed = false): OpOutcome => ({
    op: structuredClone(op),
    pageIndex: op.page,
    blockId: op.blockId,
    geometry,
    removed,
  });

  switch (op.op) {
    case "remove_block": {
      page.blocks.splice(index, 1);
      return done(false, true);
    }
    case "set_rect": {
      const rectErr = rectError(op.rect, page);
      if (rectErr) return { error: rectErr };
      page.blocks[index] = { ...block, anchor: undefined, rect: { ...op.rect } };
      return done(true);
    }
    case "set_block_props": {
      const keys = Object.keys(op.props) as (keyof typeof op.props)[];
      if (keys.length === 0) return { error: "props is empty — nothing to change" };
      const numErr = numberPropsError(op.props);
      if (numErr) return { error: numErr };
      const merged: LayoutBlock = { ...block };
      for (const key of keys) {
        if (key === "border") {
          if (op.props.border === null) delete merged.border;
          else if (op.props.border !== undefined) merged.border = structuredClone(op.props.border);
        } else if (op.props[key] !== undefined) {
          (merged as Record<string, unknown>)[key] = op.props[key];
        }
      }
      const parsed = LayoutBlockSchema.safeParse(merged);
      if (!parsed.success) return { error: `the block would be invalid: ${issuesText(parsed.error.issues)}` };
      page.blocks[index] = merged;
      return done(false);
    }
    case "edit_line": {
      const err = existingLineError(block, op.page, op.line, op.oldText);
      if (err) return { error: err };
      if (op.newText === op.oldText) return { error: "newText is the same as oldText — nothing to change" };
      const lineErr = lineError(op.newText);
      if (lineErr) return { error: lineErr };
      block.lines = block.lines.map((l, i) => (i === op.line ? op.newText : l));
      return done(false);
    }
    case "insert_line": {
      const n = block.lines.length;
      if (op.line < 0 || op.line > n) {
        return { error: `insert position ${op.line} is out of range for block "${block.id}" — use 0–${n} (${n} appends after the last line)` };
      }
      if (n >= MAX_LINES) return { error: `block "${block.id}" already has the maximum of ${MAX_LINES} lines` };
      const lineErr = lineError(op.text);
      if (lineErr) return { error: lineErr };
      block.lines = [...block.lines.slice(0, op.line), op.text, ...block.lines.slice(op.line)];
      return done(false);
    }
    case "remove_line": {
      const err = existingLineError(block, op.page, op.line, op.oldText);
      if (err) return { error: err };
      block.lines = block.lines.filter((_, i) => i !== op.line);
      return done(false);
    }
  }
}

function findPage(def: LayoutDef, page: number): { page: LayoutPage } | { error: string } {
  const n = def.pages.length;
  if (page < 0 || page >= n) {
    return {
      error: `page ${page} does not exist — pages are numbered from 0 and this layout has ${n} (${n === 1 ? "0" : `0–${n - 1}`})`,
    };
  }
  return { page: def.pages[page] };
}

function findBlock(page: LayoutPage, pageIndex: number, blockId: string): { index: number } | { error: string } {
  const index = page.blocks.findIndex((b) => b.id === blockId);
  if (index >= 0) return { index };
  const ids = page.blocks.map((b) => b.id ?? "?");
  const shown = ids.length > 30 ? `${ids.slice(0, 30).join(", ")}, …` : ids.join(", ");
  return { error: `no block "${blockId}" on page ${pageIndex} — blocks there: ${shown || "none"}` };
}

function rectError(rect: LayoutRect, page: LayoutPage): string | null {
  const { cols, rows } = pageGrid(page);
  if (rect.col < 0 || rect.row < 0) return `rect col and row must be 0 or more (got col ${rect.col}, row ${rect.row})`;
  if (rect.colSpan < 1 || rect.rowSpan < 1) {
    return `rect colSpan and rowSpan must be at least 1 (got ${rect.colSpan}×${rect.rowSpan})`;
  }
  if (rect.col + rect.colSpan > cols) {
    return `rect runs past the page grid horizontally: col ${rect.col} + colSpan ${rect.colSpan} = ${rect.col + rect.colSpan}, but the grid has ${cols} columns`;
  }
  if (rect.row + rect.rowSpan > rows) {
    return `rect runs past the page grid vertically: row ${rect.row} + rowSpan ${rect.rowSpan} = ${rect.row + rect.rowSpan}, but the grid has ${rows} rows`;
  }
  return null;
}

function lineError(text: string): string | null {
  const errs = validateLayoutLine(text);
  return errs.length ? `line ${JSON.stringify(clip(text, 120))}: ${errs.join("; ")}` : null;
}

function existingLineError(block: LayoutBlock, pageIndex: number, line: number, oldText: string): string | null {
  const n = block.lines.length;
  if (line < 0 || line >= n) {
    return n === 0
      ? `block "${block.id}" has no lines`
      : `line ${line} does not exist on block "${block.id}" — it has ${n} line${n === 1 ? "" : "s"} (${n === 1 ? "0" : `0–${n - 1}`})`;
  }
  const actual = block.lines[line];
  if (actual !== oldText) {
    return `line ${line} of block "${block.id}" on page ${pageIndex} is ${JSON.stringify(actual)}, not ${JSON.stringify(oldText)} — the layout may have changed; re-read it and retry`;
  }
  return null;
}

function numberPropsError(p: { fontPt?: number; lineHeight?: number }): string | null {
  if (p.fontPt !== undefined && (p.fontPt < FONT_PT_MIN || p.fontPt > FONT_PT_MAX)) {
    return `fontPt must be between ${FONT_PT_MIN} and ${FONT_PT_MAX} (got ${p.fontPt})`;
  }
  if (p.lineHeight !== undefined && (p.lineHeight < LINE_HEIGHT_MIN || p.lineHeight > LINE_HEIGHT_MAX)) {
    return `lineHeight must be between ${LINE_HEIGHT_MIN} and ${LINE_HEIGHT_MAX} (got ${p.lineHeight})`;
  }
  return null;
}

// ---------------------------------------------------------------------
// Warnings — only for blocks the ops touched (an existing layout's own
// overlaps are not this patch's news), computed on the FINAL definition so a
// block added and then removed in the same patch says nothing.
// ---------------------------------------------------------------------

const PT_TO_MM = 25.4 / 72;
// Average glyph advance of the label fonts, in em. Rough by design.
const CHAR_EM = 0.55;
// A token with no usable palette example is assumed this many characters.
const DEFAULT_TOKEN_CHARS = 8;
// {{= … }} results are short numbers.
const CALC_CHARS = 4;
// Float slack so a block that exactly fits doesn't warn.
const FIT_SLACK_MM = 0.05;

function collectWarnings(
  def: LayoutDef,
  touched: { pageIndex: number; blockId: string; geometry: boolean }[],
): string[] {
  const warnings: string[] = [];
  const seenPairs = new Set<string>();
  const multiPage = def.pages.length > 1;
  for (const t of touched) {
    const page = def.pages[t.pageIndex];
    const block = page?.blocks.find((b) => b.id === t.blockId);
    if (!page || !block) continue;
    const where = multiPage ? ` on page ${t.pageIndex}` : "";
    if (t.geometry && block.rect) {
      for (const other of page.blocks) {
        if (other === block || !other.rect || !rectsOverlap(block.rect, other.rect)) continue;
        const pair = [t.pageIndex, ...[block.id, other.id].sort()].join("|");
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        warnings.push(`Block ${block.id} overlaps block ${other.id}${where} — check the proof that they don't collide.`);
      }
    }
    warnings.push(...overflowWarnings(block, page, where));
    if (block.fontPt < MIN_PRINT_PT) {
      warnings.push(`Block ${block.id}${where} is set to ${fmtNum(block.fontPt)} pt — below the ${MIN_PRINT_PT} pt minimum for printed text.`);
    }
  }
  return warnings;
}

function rectsOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  );
}

// Content box of a rect block in mm — the renderer's arithmetic (grid over
// the page minus margins, less the border rules that print and the inner
// padding), at the authored size.
function blockContentMm(block: LayoutBlock, page: LayoutPage): { widthMm: number; heightMm: number } | null {
  if (!block.rect) return null;
  const { cols, rows } = pageGrid(page);
  const m = page.margins ?? { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 };
  let widthMm = ((page.widthMm - m.leftMm - m.rightMm) * block.rect.colSpan) / cols;
  let heightMm = ((page.heightMm - m.topMm - m.bottomMm) * block.rect.rowSpan) / rows;
  if (block.border) {
    const sides = effectiveBorderSides(block.border);
    const pad = effectiveBorderPad(block.border);
    const w = block.border.widthMm;
    widthMm -= w * (Number(sides.left) + Number(sides.right)) + pad.leftMm + pad.rightMm;
    heightMm -= w * (Number(sides.top) + Number(sides.bottom)) + pad.topMm + pad.bottomMm;
  }
  return { widthMm: Math.max(0, widthMm), heightMm: Math.max(0, heightMm) };
}

// Rendered length of a line in characters: tokens become their palette
// example (or a default), calcs a short number, a conditional its LONGER
// branch. null when the line holds a graphic (barcode, symbols, image,
// table) — those size by their own rules and only the proof can judge them.
function estimateLineChars(line: string): number | null {
  let graphic = false;
  const plain = (s: string) =>
    s
      .replace(new RegExp(CALC_RE.source, "g"), "0".repeat(CALC_CHARS))
      .replace(new RegExp(TOKEN_RE.source, "g"), (_m, key: string) => {
        if (key === "else" || key === "endif") return "";
        const meta = tokenMeta(key);
        if (meta && meta.kind !== "text") {
          graphic = true;
          return "";
        }
        return "x".repeat(exampleChars(meta?.example));
      });
  const withoutIfs = line.replace(
    new RegExp(IF_RE.source, "g"),
    (_m, _f, _o, _v, ifBody?: string, elseBody?: string) => {
      const a = plain(ifBody ?? "");
      const b = plain(elseBody ?? "");
      return a.length >= b.length ? a : b;
    },
  );
  const text = plain(withoutIfs);
  return graphic ? null : text.length;
}

// Palette examples sometimes carry usage notes ("48 · {{qtyPerCarton:outer}}");
// the value is the part before the first " · ".
function exampleChars(example?: string): number {
  if (!example) return DEFAULT_TOKEN_CHARS;
  const first = example.split(" · ")[0].trim();
  return first && !first.includes("{{") ? first.length : DEFAULT_TOKEN_CHARS;
}

function overflowWarnings(block: LayoutBlock, page: LayoutPage, where: string): string[] {
  const box = blockContentMm(block, page);
  if (!box || block.lines.length === 0) return [];
  const chars = block.lines.map(estimateLineChars);
  if (chars.some((c) => c === null)) return [];
  const counts = chars as number[];
  const out: string[] = [];
  const charMm = block.fontPt * CHAR_EM * PT_TO_MM;

  // Width — a line too long for the block wraps (lines are pre-wrap). A
  // fitWidth block scales each line to the width instead, so it never does.
  if (!block.fitWidth && box.widthMm > 0) {
    const longest = Math.max(...counts);
    const longestMm = longest * charMm;
    if (longestMm > box.widthMm + FIT_SLACK_MM) {
      out.push(
        `Block ${block.id}${where}: the longest line is ~${fmtNum(longestMm)} mm wide at ${fmtNum(block.fontPt)} pt but the block is ${fmtNum(box.widthMm)} mm wide — it will likely wrap.`,
      );
    }
  }

  // Height — line boxes are fontPt × lineHeight each, counting the extra rows
  // a wrapping line takes. A fitWidth line's font is whatever fills the
  // width; a fitHeight block shrinks to fit, so it never overflows.
  if (!block.fitHeight && box.heightMm > 0) {
    let needMm = 0;
    for (const c of counts) {
      if (block.fitWidth) {
        const pt = c > 0 && box.widthMm > 0 ? box.widthMm / (c * CHAR_EM * PT_TO_MM) : block.fontPt;
        needMm += pt * block.lineHeight * PT_TO_MM;
      } else {
        const rows = c > 0 && box.widthMm > 0 ? Math.max(1, Math.ceil((c * charMm) / box.widthMm)) : 1;
        needMm += rows * block.fontPt * block.lineHeight * PT_TO_MM;
      }
    }
    if (needMm > box.heightMm + FIT_SLACK_MM) {
      out.push(
        `Block ${block.id}${where}: its text needs ~${fmtNum(needMm)} mm of height (${fmtNum(block.fontPt)} pt, line height ${fmtNum(block.lineHeight)}) but the block is ${fmtNum(box.heightMm)} mm tall — it will likely overflow.`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// describeLayoutChanges — a plain-English diff of two definitions, for the
// review screen's definition diff and the learning signals' edit kinds.
// Works on any pair (not just op output), so a builder edit or a restore
// diffs the same way.
// ---------------------------------------------------------------------

export type LayoutChangeKind = "add_block" | "remove_block" | "move" | "resize" | "props" | "text" | "page";
// `page` is the 0-based page index in `after` (in `before` for a removed
// page); layout-wide settings changes are reported as kind "page" on page 0.
export type LayoutChange = { kind: LayoutChangeKind; page: number; blockId?: string; summary: string };

export function describeLayoutChanges(before: LayoutDef, after: LayoutDef): LayoutChange[] {
  const a = normalise(before);
  const b = normalise(after);
  const multiPage = Math.max(a.pages.length, b.pages.length) > 1;
  const onPage = (i: number) => (multiPage ? ` (page ${i + 1})` : "");
  const out: LayoutChange[] = [];

  const beforePages = new Map<string, { page: LayoutPage; index: number }>();
  a.pages.forEach((page, index) => {
    if (!beforePages.has(page.id)) beforePages.set(page.id, { page, index });
  });
  const afterIds = new Set(b.pages.map((p) => p.id));

  a.pages.forEach((page, index) => {
    if (afterIds.has(page.id)) return;
    out.push({
      kind: "page",
      page: index,
      summary: `Removed page ${index + 1}${page.title ? ` "${page.title}"` : ""} (${fmtNum(page.widthMm)}×${fmtNum(page.heightMm)} mm, ${countText(page.blocks.length, "block")})`,
    });
  });

  b.pages.forEach((page, index) => {
    const prev = beforePages.get(page.id);
    if (!prev) {
      out.push({
        kind: "page",
        page: index,
        summary: `Added page ${index + 1}${page.title ? ` "${page.title}"` : ""} (${fmtNum(page.widthMm)}×${fmtNum(page.heightMm)} mm, ${countText(page.blocks.length, "block")})`,
      });
      return;
    }
    out.push(...pageChanges(prev.page, page, index, onPage(index)));
    out.push(...blockChanges(prev.page, page, index, onPage(index)));
  });

  const settings = settingsChanges(a, b);
  if (settings.length) {
    out.push({ kind: "page", page: 0, summary: `Layout settings changed: ${settings.join(", ")}` });
  }
  return out;
}

function normalise(def: LayoutDef): LayoutDef {
  try {
    return parseLayoutDef(structuredClone(def));
  } catch {
    // Not valid enough to parse — diff it as stored, with positional ids.
    const raw = structuredClone(def);
    for (const page of raw.pages ?? []) {
      page.blocks = (page.blocks ?? []).map((blk, i) => ({ ...blk, id: blk.id ?? `b-r${i}` }));
    }
    return raw;
  }
}

const PAGE_FIELDS: ReadonlyArray<{ key: keyof LayoutPage; label: string }> = [
  { key: "title", label: "Page title" },
  { key: "margins", label: "Margins" },
  { key: "sewingLines", label: "Sewing lines" },
  { key: "foldLine", label: "Fold line" },
  { key: "pageBorder", label: "Page border" },
  { key: "centerHole", label: "Hang hole" },
  { key: "cornerRadiusMm", label: "Corner radius (mm)" },
  { key: "cutLine", label: "Cut line" },
  { key: "omitWhenEmpty", label: "Omit when empty" },
];

function pageChanges(a: LayoutPage, b: LayoutPage, index: number, where: string): LayoutChange[] {
  const out: LayoutChange[] = [];
  const push = (summary: string) => out.push({ kind: "page", page: index, summary: summary + where });
  if (a.widthMm !== b.widthMm || a.heightMm !== b.heightMm) {
    push(`Page size ${fmtNum(a.widthMm)}×${fmtNum(a.heightMm)} → ${fmtNum(b.widthMm)}×${fmtNum(b.heightMm)} mm`);
  }
  const ga = pageGrid(a);
  const gb = pageGrid(b);
  if (ga.cols !== gb.cols || ga.rows !== gb.rows) {
    push(`Page grid ${ga.cols}×${ga.rows} → ${gb.cols}×${gb.rows}`);
  }
  for (const { key, label } of PAGE_FIELDS) {
    const va = a[key];
    const vb = b[key];
    if (sameValue(va, vb)) continue;
    push(valueChange(label, va, vb));
  }
  return out;
}

function blockChanges(a: LayoutPage, b: LayoutPage, index: number, where: string): LayoutChange[] {
  const out: LayoutChange[] = [];
  const beforeById = new Map(a.blocks.map((blk) => [blk.id ?? "", blk]));
  const afterIds = new Set(b.blocks.map((blk) => blk.id ?? ""));
  const push = (kind: LayoutChangeKind, blockId: string, summary: string) =>
    out.push({ kind, page: index, blockId, summary: summary + where });

  for (const blk of a.blocks) {
    const id = blk.id ?? "";
    if (afterIds.has(id)) continue;
    push("remove_block", id, `Removed block ${id} at ${rectText(blk.rect)}: ${linesPreview(blk.lines)}`);
  }

  for (const blk of b.blocks) {
    const id = blk.id ?? "";
    const prev = beforeById.get(id);
    if (!prev) {
      push("add_block", id, `Added a block at ${rectText(blk.rect)}: ${linesPreview(blk.lines)}`);
      continue;
    }
    const ra = prev.rect;
    const rb = blk.rect;
    if (ra && rb) {
      if (ra.col !== rb.col || ra.row !== rb.row) {
        push("move", id, `Moved block ${id} from col ${ra.col}, row ${ra.row} to col ${rb.col}, row ${rb.row}`);
      }
      if (ra.colSpan !== rb.colSpan || ra.rowSpan !== rb.rowSpan) {
        push("resize", id, `Resized block ${id} from ${ra.colSpan}×${ra.rowSpan} to ${rb.colSpan}×${rb.rowSpan}`);
      }
    } else if (!sameValue(ra, rb) || prev.anchor !== blk.anchor) {
      push("move", id, `Moved block ${id} from ${rectText(ra)} to ${rectText(rb)}`);
    }
    for (const summary of propChanges(prev, blk)) push("props", id, summary);
    for (const summary of lineChanges(prev.lines, blk.lines, id)) push("text", id, summary);
  }
  return out;
}

function propChanges(a: LayoutBlock, b: LayoutBlock): string[] {
  const id = b.id;
  const out: string[] = [];
  const onOff = (v: boolean) => (v ? "on" : "off");
  if (a.fontPt !== b.fontPt) out.push(`Font ${fmtNum(a.fontPt)} → ${fmtNum(b.fontPt)} pt on block ${id}`);
  if (a.bold !== b.bold) out.push(`Bold ${onOff(b.bold)} for block ${id}`);
  if ((a.align ?? "left") !== (b.align ?? "left")) {
    out.push(`Alignment ${a.align ?? "left"} → ${b.align ?? "left"} on block ${id}`);
  }
  if ((a.valign ?? "top") !== (b.valign ?? "top")) {
    out.push(`Vertical alignment ${a.valign ?? "top"} → ${b.valign ?? "top"} on block ${id}`);
  }
  if (a.lineHeight !== b.lineHeight) {
    out.push(`Line height ${fmtNum(a.lineHeight)} → ${fmtNum(b.lineHeight)} on block ${id}`);
  }
  if (a.fitWidth !== b.fitWidth) out.push(`Fit to width ${onOff(b.fitWidth)} for block ${id}`);
  if (a.fitHeight !== b.fitHeight) out.push(`Shrink to fit height ${onOff(b.fitHeight)} for block ${id}`);
  if (a.invert !== b.invert) out.push(`Invert ${onOff(b.invert)} for block ${id}`);
  if (a.invertBg !== b.invertBg || a.invertText !== b.invertText) out.push(`Invert colours changed on block ${id}`);
  if (!sameValue(a.border, b.border)) {
    if (!a.border && b.border) out.push(`Border added to block ${id} (${fmtNum(b.border.widthMm)} mm ${b.border.color})`);
    else if (a.border && !b.border) out.push(`Border removed from block ${id}`);
    else out.push(`Border changed on block ${id}`);
  }
  return out;
}

// Line diff by longest common subsequence; a removed run next to an added run
// pairs up as edits ("line 2: A → B") rather than a remove plus an add.
function lineChanges(a: string[], b: string[], id: string | undefined): string[] {
  if (a.length === b.length && a.every((l, i) => l === b[i])) return [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      out.push(`Line ${adds[k] + 1} on block ${id}: ${quote(a[dels[k]])} → ${quote(b[adds[k]])}`);
    }
    for (const i of dels.slice(pairs)) out.push(`Removed line ${i + 1} from block ${id}: ${quote(a[i])}`);
    for (const j of adds.slice(pairs)) out.push(`Added line ${j + 1} to block ${id}: ${quote(b[j])}`);
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      adds.push(j++);
    } else {
      dels.push(i++);
    }
  }
  flush();
  return out;
}

function settingsChanges(a: LayoutDef, b: LayoutDef): string[] {
  const sa = layoutSettings(a) as Record<string, unknown>;
  const sb = layoutSettings(b) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (sameValue(sa[key], sb[key])) continue;
    out.push(valueChange(key, sa[key], sb[key]));
  }
  return out;
}

// ---------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------

function rectText(rect: LayoutRect | undefined): string {
  return rect ? `col ${rect.col}, row ${rect.row} (${rect.colSpan}×${rect.rowSpan})` : "a corner";
}

function linesPreview(lines: string[]): string {
  const shown = lines.filter((l) => l.trim() !== "");
  return shown.length ? clip(shown.join(" / "), 160) : "(no text)";
}

function quote(s: string): string {
  return JSON.stringify(clip(s, 120));
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function countText(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function valueChange(label: string, a: unknown, b: unknown): string {
  const simple = (v: unknown) => v === undefined || v === null || ["string", "number", "boolean"].includes(typeof v);
  if (simple(a) && simple(b)) return `${label} ${showValue(a)} → ${showValue(b)}`;
  return `${label} changed`;
}

function showValue(v: unknown): string {
  if (v === undefined || v === null) return "none";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return fmtNum(v);
  return String(v);
}

// Structural equality that treats an absent key and `undefined` alike (zod
// and parseLayoutDef leave `undefined` keys behind) and ignores key order (a
// builder-written border and an op-written one needn't list keys alike).
function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(v: unknown): string | undefined {
  return JSON.stringify(v, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : val,
  );
}

function cloneOp(op: unknown): LayoutOp {
  try {
    return structuredClone(op) as LayoutOp;
  } catch {
    return op as LayoutOp;
  }
}

function issuesText(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

function errorText(err: unknown): string {
  if (err instanceof z.ZodError) return issuesText(err.issues);
  return err instanceof Error ? err.message : String(err);
}

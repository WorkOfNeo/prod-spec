// =====================================================
// The cross-LAYOUT block clipboard.
//
// Copying blocks WITHIN a layout is component state (see layout-editor's
// formatClip). Copying between layouts can't be: each layout is its own
// page, so the editor unmounts on the way. This puts the payload in
// localStorage instead, which survives the navigation — and a second tab,
// and coming back an hour later.
//
// Two things make this more than a JSON.stringify:
//
//   • localStorage is untrusted input. It is user-writable, it outlives
//     deploys, and a payload written by an older build can be any shape at
//     all. Every read is re-validated through LayoutBlockSchema, and any
//     failure degrades to "clipboard is empty" rather than throwing into
//     the editor.
//   • Layouts don't share a grid. A block copied from a 100×75 mm page on
//     a 25×19 grid into a 35×90 mm care label on 9×23 would land far
//     outside its target — and LayoutPageSchema's superRefine rejects an
//     out-of-grid rect at publish. So a paste REMAPS proportionally, the
//     same arithmetic the builder's "Regenerate grid" already uses.
// =====================================================
import { z } from "zod";
import { LayoutBlockSchema, LAYOUT_GRID_MAX, type LayoutBlock, type LayoutRect } from "./schema";

export const BLOCK_CLIPBOARD_KEY = "prodspec.outputBuilder.blockClipboard";
// Bumped only for a breaking payload change; a mismatch reads as empty,
// which is the correct degradation for a clipboard (you re-copy).
export const BLOCK_CLIPBOARD_VERSION = 1 as const;

const GridSchema = z.object({
  cols: z.number().int().min(1).max(LAYOUT_GRID_MAX),
  rows: z.number().int().min(1).max(LAYOUT_GRID_MAX),
});
export type LayoutGrid = z.infer<typeof GridSchema>;

export const BlockClipboardSchema = z.object({
  v: z.literal(BLOCK_CLIPBOARD_VERSION),
  copiedAt: z.string().max(40),
  // Shown on the Paste button so it's obvious what you're about to bring
  // in — "Paste 3 blocks from Runsven – Care Label" beats a blind paste.
  layoutName: z.string().max(200),
  // The grid the blocks were laid out on, without which the remap below
  // has no "from" to scale against.
  grid: GridSchema,
  blocks: z.array(LayoutBlockSchema).min(1).max(200),
});
export type BlockClipboard = z.infer<typeof BlockClipboardSchema>;

// The minimum of the Storage API this module needs — lets the tests pass a
// plain in-memory stub, since node has no localStorage.
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// localStorage access throws outright in some privacy modes, so every entry
// point is guarded rather than assuming the API exists.
function storage(explicit?: StorageLike): StorageLike | null {
  if (explicit) return explicit;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// Read the clipboard, or null when it's empty, unreadable, written by an
// incompatible build, or holding blocks that no longer satisfy the schema.
export function readBlockClipboard(explicit?: StorageLike): BlockClipboard | null {
  const store = storage(explicit);
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(BLOCK_CLIPBOARD_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = BlockClipboardSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Put blocks on the clipboard. Returns false when storage is unavailable or
// full, so the caller can say so instead of silently doing nothing.
export function writeBlockClipboard(
  input: { blocks: LayoutBlock[]; grid: LayoutGrid; layoutName: string; now?: Date },
  explicit?: StorageLike,
): boolean {
  const store = storage(explicit);
  if (!store || input.blocks.length === 0) return false;
  const payload: BlockClipboard = {
    v: BLOCK_CLIPBOARD_VERSION,
    copiedAt: (input.now ?? new Date()).toISOString(),
    layoutName: input.layoutName.slice(0, 200),
    grid: input.grid,
    blocks: input.blocks,
  };
  try {
    store.setItem(BLOCK_CLIPBOARD_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // Quota exceeded, or storage disabled mid-session.
    return false;
  }
}

export function clearBlockClipboard(explicit?: StorageLike): void {
  const store = storage(explicit);
  try {
    store?.removeItem(BLOCK_CLIPBOARD_KEY);
  } catch {
    // Nothing useful to do — the clipboard is best-effort by nature.
  }
}

// Scale a rect from one grid to another, keeping it inside the target.
// The ONE place this arithmetic lives — shared by the cross-layout paste
// and the builder's "Regenerate grid", which must agree or the same block
// would move differently depending on how it got resized.
export function remapRectToGrid(rect: LayoutRect, from: LayoutGrid, to: LayoutGrid): LayoutRect {
  const col = Math.min(to.cols - 1, Math.round((rect.col / from.cols) * to.cols));
  const row = Math.min(to.rows - 1, Math.round((rect.row / from.rows) * to.rows));
  return {
    col,
    row,
    colSpan: Math.max(1, Math.min(to.cols - col, Math.round((rect.colSpan / from.cols) * to.cols))),
    rowSpan: Math.max(1, Math.min(to.rows - row, Math.round((rect.rowSpan / from.rows) * to.rows))),
  };
}

// The blocks a paste should actually insert: remapped onto the target grid
// and given fresh ids, because the source ids may already be in use on this
// page (pasting a layout back into itself) and ids drive selection.
export function blocksForPaste(
  clip: BlockClipboard,
  targetGrid: LayoutGrid,
  newId: () => string,
): LayoutBlock[] {
  return clip.blocks.map((b) => ({
    ...b,
    id: newId(),
    ...(b.rect ? { rect: remapRectToGrid(b.rect, clip.grid, targetGrid) } : {}),
    // Copy the arrays/objects a block owns, so an edit after pasting can't
    // reach back into the parsed clipboard payload.
    lines: [...b.lines],
    ...(b.border
      ? { border: { ...b.border, ...(b.border.pad ? { pad: { ...b.border.pad } } : {}) } }
      : {}),
  }));
}

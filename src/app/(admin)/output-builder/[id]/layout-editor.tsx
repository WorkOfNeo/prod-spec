"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocTypeEntry } from "@/lib/pdf/doc-types";
import type { FileNamePreset } from "@/lib/settings/app-settings";
import {
  DEFAULT_GRID_CELL_MM,
  LAYOUT_GRID_COLS,
  LAYOUT_GRID_ROWS,
  LayoutDefSchema,
  TOKEN_RE,
  blockId,
  effectiveBorderPad,
  gridFromCellMm,
  layoutSettings,
  pageGrid,
  tokensInDef,
  type FoldLine,
  type LayoutBlock,
  type LayoutDef,
  type LayoutPage,
  type LayoutRect,
  type LayoutSettings,
  type PageBorder,
  type SewingLine,
} from "@/lib/output-layouts/schema";
import {
  LAYOUT_TOKENS,
  tokenMeta,
  SIBLING_FIELDS,
  MAX_SIBLING_SLOTS,
  SIZE_SCOPE_ARG,
} from "@/lib/output-layouts/token-meta";
import { validateCalcExpression } from "@/lib/output-layouts/calc";
import { CARTON_QTY_KINDS } from "@/lib/output-layouts/carton-qty";
import { PreviewFrame } from "@/components/output-preview";
import { TokenAutocomplete, buildTokenSuggestions } from "@/components/token-autocomplete";

// =====================================================
// Output Builder editor — one layout, three panes:
//   left   pages (title + mm dims + orientation)
//   center canvas (true aspect, 12×12 grid) + true-render preview
//   right  block inspector + variables palette
//
// Two block placement models:
//   • corner blocks — click a "+ text" corner zone; anchored, width in
//     grid columns, grows inward
//   • rect blocks — DRAW a rectangle on the grid (pointer drag); placed
//     by cell coords with align/valign — fully centered designs
//
// Test data: pick customer × business area, search or cycle through that
// pair's styles ranked fullest-first; the preview below the canvas always
// shows the REAL renderer's output for the selected style.
// =====================================================

const AUTOSAVE_MS = 1200;
const PREVIEW_DEBOUNCE_MS = 600;
const PT_TO_MM = 25.4 / 72;

// mm input accepts a comma OR dot decimal ("7,5" → 7.5).
function parseMm(raw: string): number {
  return Number(String(raw).replace(",", ".").trim());
}


// Id generators — module scope, called from event handlers only (the
// react-hooks/purity rule forbids impure calls reachable from render).
let blockSeq = 0;
function newBlockId(): string {
  blockSeq += 1;
  return `b-${Date.now().toString(36)}-${blockSeq}`;
}
function newPageId(): string {
  blockSeq += 1;
  return `p-${Date.now().toString(36)}-${blockSeq}`;
}

type Customer = { id: string; name: string };
type BusinessArea = { id: string; name: string };
type Language = { code: string; name: string };

type TestStyle = {
  id: string;
  name: string;
  poNumber: string | null;
  filled: number;
  total: number;
  missing: string[];
};

type LayoutProps = {
  id: string;
  name: string;
  docType: string;
  status: "DRAFT" | "PUBLISHED";
  version: number;
  autoApprove: boolean;
  isInfoArea: boolean;
  // Per-layout {{logo:custom}} image (data URL) — managed by its own upload
  // endpoint, not the autosave payload.
  customLogo: string | null;
  customerId: string | null;
  businessAreaId: string | null;
  definition: LayoutDef;
};

// Single-output view tabs. The canvas lives in "customizer" and stays there;
// switching tabs swaps the surrounding panels, not the canvas's home.
type LayoutTab = "customizer" | "reviews" | "settings";

// Plain (db-free) shapes the server page passes in — the editor is a client
// component, so these must NOT import from stats.ts (which pulls in db).
type GenerationStats = {
  total: number;
  approved: number;
  pendingReview: number;
  rejected: number;
  distinctStyles: number;
  lastGeneratedAt: string | null;
};
type RecentAsset = {
  id: string;
  displayName: string | null;
  fileName: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  placeholderCount: number;
  createdAt: string;
  jobId: string;
  styleId: string;
  styleName: string;
};

type DrawState = {
  startCol: number;
  startRow: number;
  curCol: number;
  curRow: number;
  startX: number;
  startY: number;
  moved: boolean;
};

export function LayoutEditor({
  layout,
  customers,
  businessAreas,
  languages,
  docTypes,
  stats,
  recentAssets,
  prodSpecs,
}: {
  layout: LayoutProps;
  customers: Customer[];
  businessAreas: BusinessArea[];
  languages: Language[];
  // The doc-type catalogue (DB-managed) — options for the type select.
  docTypes: DocTypeEntry[];
  // Generation history for the Settings + Reviews tabs (server-computed).
  stats: GenerationStats;
  recentAssets: RecentAsset[];
  // Prod Specs that reference this layout (layout:<id>) — listed in the
  // delete confirmation so the operator sees what loses the output.
  prodSpecs: Array<{ id: string; name: string; customerName: string }>;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<LayoutTab>("customizer");
  const [name, setName] = useState(layout.name);
  const [docType, setDocType] = useState(layout.docType);
  const [isInfoArea, setIsInfoArea] = useState(layout.isInfoArea);
  const [customLogo, setCustomLogo] = useState<string | null>(layout.customLogo);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [def, setDef] = useState<LayoutDef>(layout.definition);
  const [autoApprove, setAutoApprove] = useState(layout.autoApprove);
  const [customerId, setCustomerId] = useState<string | null>(layout.customerId);
  const [businessAreaId, setBusinessAreaId] = useState<string | null>(layout.businessAreaId);
  const [status, setStatus] = useState(layout.status);
  const [version, setVersion] = useState(layout.version);

  // Delete this layout — confirmation modal → DELETE → back to the list.
  // The server cleanly drops it from any referencing prod spec; generated
  // PDFs are kept.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteLayout() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/output-layouts/${layout.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push("/output-builder");
    } finally {
      setDeleting(false);
    }
  }

  const [pageIdx, setPageIdx] = useState(0);
  const [marginsLinked, setMarginsLinked] = useState(() => {
    const m = layout.definition.pages[0]?.margins;
    return !m || (m.topMm === m.rightMm && m.topMm === m.bottomMm && m.topMm === m.leftMm);
  });
  // Border-padding link/unlink for the selected block — mirrors marginsLinked.
  // Linked = one value drives all four sides; unlink to edit each side.
  const [padLinked, setPadLinked] = useState(true);
  // The cell size (mm) the "Regenerate grid" button uses. Defaults to 4 mm.
  const [gridCellMm, setGridCellMm] = useState(String(DEFAULT_GRID_CELL_MM));
  const [sel, setSel] = useState<string | null>(null);
  // The block the Blocks list is hovering — highlights that block on the
  // canvas with a blue locator ring, so a tiny or overlapped block can be
  // found by scanning the list rather than hunting the crammed canvas.
  const [hoverBlock, setHoverBlock] = useState<string | null>(null);
  // Draw state lives in a ref (handlers must see updates within the same
  // tick — fast pointermoves outrun React renders) and is mirrored into
  // state purely to render the ghost rectangle.
  const drawRef = useRef<DrawState | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);

  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [styles, setStyles] = useState<TestStyle[]>([]);
  const [styleIdx, setStyleIdx] = useState(0);
  const [stylesLoading, setStylesLoading] = useState(false);
  // Has the test-style fetch produced an answer for the CURRENT context yet?
  // Gates the live preview: a layout scoped to a customer × business area is
  // going to get a real test style, so rendering SAMPLE data in the gap before
  // it arrives just flashes a fully-populated label (sample EANs, sample
  // carton) that a moment later empties out — which reads as "my data
  // disappeared" rather than "this style has no carton EAN".
  const [stylesSettled, setStylesSettled] = useState(false);
  const [styleQuery, setStyleQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewSample, setPreviewSample] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [repeatValues, setRepeatValues] = useState<string[]>([]);
  const [resolvedFileName, setResolvedFileName] = useState<string | null>(null);
  const [showValues, setShowValues] = useState(false);
  const [tokenValues, setTokenValues] = useState<Record<string, string>>({});

  // "Preview as carton N of M" — drives the live preview's cartonSerial
  // when this layout is carton-numbering-eligible.
  const [cartonPreviewNo, setCartonPreviewNo] = useState(1);
  const [cartonPreviewTotal, setCartonPreviewTotal] = useState(10);

  const [publishing, setPublishing] = useState(false);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [pdfBusy, setPdfBusy] = useState(false);

  const [langSel, setLangSel] = useState(languages[0]?.code ?? "en");
  // Custom Carton Marking — which sibling slot the palette chips insert.
  const [siblingSlot, setSiblingSlot] = useState(2);

  // The fuzzy-autofill catalogue for the content editor — mirrors the palette,
  // built for the current language + sibling slot so ":lang"/"styleN" tokens
  // insert the right variant.
  const tokenSuggestions = useMemo(
    () => buildTokenSuggestions({ langSel, siblingSlot }),
    [langSel, siblingSlot],
  );

  const [jsonText, setJsonText] = useState("");
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const contentTaRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  // Keeps the operator's picked test style selected across the background
  // re-ranks the test-styles effect fires while you edit. A ref (not a dep)
  // so the fetch closure reads the latest pick without re-running the effect.
  const selectedStyleIdRef = useRef<string | null>(null);
  // The context (customer|area|search) the styles list was last fetched for.
  // Only a change here shows the blocking loader + re-picks a style; a token
  // re-rank keeps the current list, nav and selection in place — no jump.
  const styleCtxRef = useRef<string>("");

  // Guide drawer — the "?" beside Save/Open PDF opens an in-editor reader for
  // the admin Output Builder guide (also at /guides/output-builder).
  const [guideOpen, setGuideOpen] = useState(false);

  const page: LayoutPage | undefined = def.pages[pageIdx];
  const selBlock = page?.blocks.find((b) => blockId(b) === sel) ?? null;
  const testStyle = styles[styleIdx] ?? null;
  // The current page's placement grid (cols×rows) — stored, or the legacy
  // 12×12 default. Drives the canvas overlay, drawing and block geometry.
  const grid = page ? pageGrid(page) : { cols: LAYOUT_GRID_COLS, rows: LAYOUT_GRID_ROWS };

  // ---- definition mutators (immutably rewrite def) --------------------

  const updatePage = useCallback(
    (patch: Partial<LayoutPage>) => {
      setDef((d) => ({
        ...d,
        pages: d.pages.map((p, i) => (i === pageIdx ? { ...p, ...patch } : p)),
      }));
    },
    [pageIdx],
  );

  // Print-guide mutators (current page). Sewing lines append/edit/remove;
  // the fold line is a single per-page setting.
  const sewingLines = page?.sewingLines ?? [];
  function addSewingLine() {
    updatePage({ sewingLines: [...sewingLines, { edge: "top", offsetMm: 5 }] });
  }
  function updateSewingLine(i: number, patch: Partial<SewingLine>) {
    updatePage({ sewingLines: sewingLines.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  }
  function removeSewingLine(i: number) {
    updatePage({ sewingLines: sewingLines.filter((_, idx) => idx !== i) });
  }
  function setFoldLine(v: FoldLine) {
    updatePage({ foldLine: v });
  }

  // Page border — one frame around the whole page, so a design doesn't need
  // a dummy full-page block just to get an outline. Absent = off.
  const pageBorder = page?.pageBorder;
  function togglePageBorder(on: boolean) {
    updatePage({ pageBorder: on ? { widthMm: 0.3, color: "#000000", insetMm: 0 } : undefined });
  }
  function updatePageBorder(patch: Partial<PageBorder>) {
    if (!pageBorder) return;
    updatePage({ pageBorder: { ...pageBorder, ...patch } });
  }

  // Recompute the grid from a square cell size and remap existing blocks
  // proportionally into the new grid (clamped to fit) — keep what we can;
  // the user can then nudge anything the resize shifted.
  function regenerateGrid() {
    if (!page) return;
    const cell = parseMm(gridCellMm);
    if (!Number.isFinite(cell) || cell <= 0) return;
    const next = gridFromCellMm(page.widthMm, page.heightMm, cell);
    const old = pageGrid(page);
    const blocks = page.blocks.map((b) => {
      if (!b.rect) return b;
      const r = b.rect;
      const col = Math.min(next.cols - 1, Math.round((r.col / old.cols) * next.cols));
      const row = Math.min(next.rows - 1, Math.round((r.row / old.rows) * next.rows));
      const colSpan = Math.max(1, Math.min(next.cols - col, Math.round((r.colSpan / old.cols) * next.cols)));
      const rowSpan = Math.max(1, Math.min(next.rows - row, Math.round((r.rowSpan / old.rows) * next.rows)));
      return { ...b, rect: { col, row, colSpan, rowSpan } };
    });
    updatePage({ gridCols: next.cols, gridRows: next.rows, blocks });
  }

  const updateBlock = useCallback(
    (id: string, patch: Partial<LayoutBlock>) => {
      setDef((d) => ({
        ...d,
        pages: d.pages.map((p, i) =>
          i === pageIdx
            ? { ...p, blocks: p.blocks.map((b) => (blockId(b) === id ? { ...b, ...patch } : b)) }
            : p,
        ),
      }));
    },
    [pageIdx],
  );

  const settings = layoutSettings(def);
  function updateSettings(patch: Partial<LayoutSettings>) {
    setDef((d) => ({ ...d, settings: { ...layoutSettings(d), ...patch } }));
  }

  // Does the definition actually place a carton-number token? Drives the
  // "tokens not used yet" warning when carton numbering is enabled.
  const usesCartonTokens = useMemo(
    () =>
      tokensInDef(def).some(
        (t) => t.key === "cartonNo" || t.key === "cartonTotal" || t.key === "cartonNoPadded",
      ),
    [def],
  );

  // Whether the design places the per-layout custom logo — gates the upload
  // + width controls so they only appear when {{logo:custom}} is in use.
  const usesCustomLogo = useMemo(
    () => tokensInDef(def).some((t) => t.key === "logo" && t.arg === "custom"),
    [def],
  );

  // Upload / clear the per-layout custom logo. Its own endpoint (not the
  // autosave payload) since the data URL is too big to ride every keystroke.
  async function uploadCustomLogo(file: File) {
    setLogoError(null);
    if (file.size > 450_000) {
      setLogoError("Keep the logo under ~450 KB.");
      return;
    }
    setLogoBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("could not read file"));
        r.readAsDataURL(file);
      });
      const res = await fetch(`/api/admin/output-layouts/${layout.id}/logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLogoError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setCustomLogo(dataUrl);
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeCustomLogo() {
    setLogoError(null);
    setLogoBusy(true);
    try {
      const res = await fetch(`/api/admin/output-layouts/${layout.id}/logo`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLogoError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setCustomLogo(null);
    } finally {
      setLogoBusy(false);
    }
  }

  function addRectBlock(rect: LayoutRect) {
    const block: LayoutBlock = {
      id: newBlockId(),
      rect,
      cols: 6,
      align: "left",
      valign: "top",
      fontPt: 9,
      bold: false,
      invert: false,
      fitWidth: false,
      fitHeight: false,
      lineHeight: 1.4,
      lines: ["New text"],
    };
    setDef((d) => ({
      ...d,
      pages: d.pages.map((p, i) => (i === pageIdx ? { ...p, blocks: [...p.blocks, block] } : p)),
    }));
    setSel(block.id!);
  }

  function removeBlock(id: string) {
    // Misclick guard: blocks with real content confirm before vanishing
    // (there is no undo). Fresh "New text" blocks delete silently.
    const block = page?.blocks.find((b) => blockId(b) === id);
    const content = (block?.lines ?? []).join(" ").trim();
    if (content && content !== "New text") {
      const lineCount = (block?.lines ?? []).filter((l) => l.trim()).length;
      if (!window.confirm(`Delete this block (${lineCount} line${lineCount === 1 ? "" : "s"})?`)) return;
    }
    setDef((d) => ({
      ...d,
      pages: d.pages.map((p, i) =>
        i === pageIdx ? { ...p, blocks: p.blocks.filter((b) => blockId(b) !== id) } : p,
      ),
    }));
    setSel(null);
  }

  function addPage() {
    const last = def.pages[def.pages.length - 1];
    const id = newPageId();
    setDef((d) => ({
      ...d,
      pages: [
        ...d.pages,
        {
          id,
          title: `Page ${d.pages.length + 1}`,
          widthMm: last.widthMm,
          heightMm: last.heightMm,
          margins: { ...last.margins },
          sewingLines: [],
          foldLine: "none",
          omitWhenEmpty: false,
          blocks: [],
        },
      ],
    }));
    setPageIdx(def.pages.length);
    setSel(null);
  }

  function removePage(i: number) {
    if (def.pages.length <= 1) return;
    const target = def.pages[i];
    if (target.blocks.length > 0 && !window.confirm(`Remove page "${target.title}" and its ${target.blocks.length} block(s)?`)) {
      return;
    }
    setDef((d) => ({ ...d, pages: d.pages.filter((_, j) => j !== i) }));
    setPageIdx((cur) => Math.max(0, cur >= i ? cur - 1 : cur));
    setSel(null);
  }

  // ---- canvas grid geometry (margin-aware) ------------------------------

  // The 12×12 grid maps to the page minus the per-side margins.
  function gridGeom(p: LayoutPage, s: number) {
    const m = p.margins ?? { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 };
    return {
      left: m.leftMm * s,
      top: m.topMm * s,
      width: (p.widthMm - m.leftMm - m.rightMm) * s,
      height: (p.heightMm - m.topMm - m.bottomMm) * s,
    };
  }

  // ---- draw-to-place (rect blocks) -------------------------------------

  function cellFromPointer(e: { clientX: number; clientY: number }): { col: number; row: number } | null {
    const el = canvasRef.current;
    if (!el || !page) return null;
    const r = el.getBoundingClientRect();
    const g = gridGeom(page, scale);
    const x = e.clientX - r.left - g.left;
    const y = e.clientY - r.top - g.top;
    const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x / g.width) * grid.cols)));
    const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((y / g.height) * grid.rows)));
    return { col, row };
  }

  function onCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Blocks and corner zones handle their own clicks.
    if ((e.target as HTMLElement).closest("[data-block],[data-zone]")) return;
    const cell = cellFromPointer(e);
    if (!cell) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Inactive/synthetic pointer — drawing still works without capture.
    }
    const d: DrawState = {
      startCol: cell.col,
      startRow: cell.row,
      curCol: cell.col,
      curRow: cell.row,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    drawRef.current = d;
    setDraw(d);
  }

  function onCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const cur = drawRef.current;
    if (!cur) return;
    const cell = cellFromPointer(e);
    if (!cell) return;
    const moved =
      cur.moved || Math.abs(e.clientX - cur.startX) > 4 || Math.abs(e.clientY - cur.startY) > 4;
    const d: DrawState = { ...cur, curCol: cell.col, curRow: cell.row, moved };
    drawRef.current = d;
    setDraw(d);
  }

  function onCanvasPointerUp() {
    const d = drawRef.current;
    drawRef.current = null;
    setDraw(null);
    if (!d) return;
    if (!d.moved) {
      // Plain click on empty grid — just deselect.
      setSel(null);
      return;
    }
    const col = Math.min(d.startCol, d.curCol);
    const row = Math.min(d.startRow, d.curRow);
    const colSpan = Math.abs(d.curCol - d.startCol) + 1;
    const rowSpan = Math.abs(d.curRow - d.startRow) + 1;
    addRectBlock({ col, row, colSpan, rowSpan });
  }

  // ---- file-name presets -----------------------------------------------

  // The shared library of file-name patterns (AppSetting-backed). Loaded
  // once; every mutation returns the whole list, so we just replace it.
  const [fileNamePresets, setFileNamePresets] = useState<FileNamePreset[]>([]);
  const [presetBusy, setPresetBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/output-layouts/file-name-presets")
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((b: { presets?: FileNamePreset[] }) => {
        if (!cancelled) setFileNamePresets(b.presets ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function mutatePresets(body: Record<string, unknown>) {
    setPresetBusy(true);
    try {
      const res = await fetch("/api/admin/output-layouts/file-name-presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => ({}))) as { presets?: FileNamePreset[] };
      if (res.ok && parsed.presets) setFileNamePresets(parsed.presets);
    } finally {
      setPresetBusy(false);
    }
  }

  function saveFileNamePreset() {
    const pattern = settings.fileName.trim();
    if (!pattern) return;
    const label = window.prompt("Name this preset", pattern)?.trim();
    if (label === undefined) return; // cancelled
    void mutatePresets({ pattern, label: label || pattern });
  }

  function deleteFileNamePreset(preset: FileNamePreset) {
    if (!window.confirm(`Remove the preset "${preset.label}"? Layouts already using it keep their file name.`)) return;
    void mutatePresets({ deleteId: preset.id });
  }

  // ---- autosave --------------------------------------------------------

  const payload = useMemo(
    () => JSON.stringify({ name, docType, isInfoArea, definition: def, customerId, businessAreaId, autoApprove }),
    [name, docType, isInfoArea, def, customerId, businessAreaId, autoApprove],
  );

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setSaveState("dirty");
    const t = window.setTimeout(async () => {
      setSaveState("saving");
      setSaveError(null);
      try {
        const res = await fetch(`/api/admin/output-layouts/${layout.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setSaveState("error");
          setSaveError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setSaveState("saved");
        setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      } catch (err) {
        setSaveState("error");
        setSaveError((err as Error).message);
      }
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [payload, layout.id]);

  // Manual save — same PATCH, immediately. The debounce means a quick
  // settings change + navigation could otherwise leave before persisting.
  async function saveNow() {
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch(`/api/admin/output-layouts/${layout.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveState("error");
        setSaveError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setSaveState("saved");
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (err) {
      setSaveState("error");
      setSaveError((err as Error).message);
    }
  }

  // Warn before leaving with unsaved/in-flight changes.
  useEffect(() => {
    if (saveState !== "dirty" && saveState !== "saving") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

  // ---- test styles -----------------------------------------------------

  // Signature of the variables in use — refetch the ranking when the
  // layout starts/stops needing a field (cheap server scan, debounced).
  const tokenSignature = useMemo(() => {
    const keys = new Set<string>();
    for (const p of def.pages) {
      for (const b of p.blocks) {
        for (const line of b.lines) {
          for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) keys.add(`${m[1]}:${m[2] ?? ""}`);
        }
      }
    }
    return [...keys].sort().join(",");
  }, [def]);

  // Track the currently-selected style id so the fetch below can re-find it
  // after a re-rank without listing styleIdx/styles as effect deps.
  useEffect(() => {
    selectedStyleIdRef.current = testStyle?.id ?? null;
  }, [testStyle?.id]);

  useEffect(() => {
    let cancelled = false;
    // A change of customer / business area / search is a genuinely new list:
    // show the loader and let the fullest style be picked. A token re-rank
    // (you edited the layout, so the fullest-first ranking may shift) is a
    // background refresh — keep the current nav + selection so it doesn't jump.
    const ctxKey = `${customerId ?? ""}|${businessAreaId ?? ""}|${styleQuery.trim()}`;
    const contextChanged = ctxKey !== styleCtxRef.current;
    styleCtxRef.current = ctxKey;
    // A new context means the current selection is about to be replaced —
    // re-close the preview gate so the swap doesn't flash sample data either.
    if (contextChanged) setStylesSettled(false);
    const t = window.setTimeout(async () => {
      if (!customerId || !businessAreaId) {
        if (!cancelled) {
          setStyles([]);
          setStylesLoading(false);
          // Unscoped layout — no test style is coming, so sample data IS the
          // preview. Open the gate rather than leaving it blank forever.
          setStylesSettled(true);
        }
        return;
      }
      if (!cancelled && contextChanged) setStylesLoading(true);
      try {
        const res = await fetch("/api/admin/output-layouts/test-styles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId,
            businessAreaId,
            definition: def,
            query: styleQuery.trim() || undefined,
          }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setStyles([]);
          return;
        }
        const body = (await res.json()) as { styles: TestStyle[] };
        if (cancelled) return;
        // Preserve the operator's pick across the refetch: re-find it by id in
        // the new ranking. Fall back to the fullest (index 0) only when it's
        // gone — a different customer, or a search that excludes it.
        const prevId = selectedStyleIdRef.current;
        const keepIdx = prevId ? body.styles.findIndex((s) => s.id === prevId) : -1;
        setStyles(body.styles);
        setStyleIdx(keepIdx >= 0 ? keepIdx : 0);
      } finally {
        if (!cancelled) {
          setStylesLoading(false);
          // Settled either way — an empty / failed list must not wedge the
          // preview shut; it falls through to sample data as before.
          setStylesSettled(true);
        }
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // def changes only matter via tokenSignature — not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, businessAreaId, tokenSignature, styleQuery]);

  // ---- live preview (true render) ---------------------------------------

  useEffect(() => {
    if (!page) return;
    // Wait for the test-style list before the FIRST render on a scoped layout
    // (see stylesSettled) — otherwise the mount-time preview paints sample
    // data and the real style immediately replaces it.
    if (!stylesSettled) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/output-layouts/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            definition: def,
            layoutId: layout.id,
            styleId: testStyle?.id,
            pageIndex: pageIdx,
            includeTokenValues: showValues,
            valuesLang: langSel,
            // Only when eligible — otherwise the carton tokens stay
            // unresolved in the preview, which is the honest default.
            cartonSerial: settings.cartonNumbering
              ? { no: cartonPreviewNo, total: cartonPreviewTotal }
              : undefined,
          }),
        });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          html: string;
          unresolved: string[];
          usingSampleData: boolean;
          tokenValues?: Record<string, string>;
          repeatValues?: string[];
          resolvedFileName?: string | null;
        };
        if (cancelled) return;
        setPreviewHtml(body.html);
        setUnresolved(body.unresolved);
        setPreviewSample(body.usingSampleData);
        setRepeatValues(body.repeatValues ?? []);
        setResolvedFileName(body.resolvedFileName ?? null);
        if (body.tokenValues) setTokenValues(body.tokenValues);
      } catch {
        // network hiccup — keep the last good preview
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(def),
    stylesSettled,
    testStyle?.id,
    pageIdx,
    showValues,
    langSel,
    settings.cartonNumbering,
    cartonPreviewNo,
    cartonPreviewTotal,
    // Re-render the preview when the per-layout custom logo is set/cleared.
    customLogo,
  ]);

  // Delete / Backspace removes the selected block — unless the user is
  // typing in an input, textarea or select (e.g. the content editor).
  useEffect(() => {
    if (!sel) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      e.preventDefault();
      removeBlock(sel);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // removeBlock isn't memoized; re-binding per render tick is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, pageIdx, def]);

  // A hovered Blocks-list row highlights its block by id; clear that when the
  // page switches so an id from the old page can't linger.
  useEffect(() => {
    setHoverBlock(null);
  }, [pageIdx]);

  // Esc closes the guide drawer.
  useEffect(() => {
    if (!guideOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGuideOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [guideOpen]);

  // ---- actions -----------------------------------------------------------

  async function publish() {
    setPublishing(true);
    setPublishErrors([]);
    try {
      const res = await fetch(`/api/admin/output-layouts/${layout.id}/publish`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        layout?: { status: "DRAFT" | "PUBLISHED"; version: number };
        error?: string;
        details?: string[];
      };
      if (!res.ok || !body.layout) {
        setPublishErrors([body.error ?? `HTTP ${res.status}`, ...(body.details ?? [])]);
        return;
      }
      setStatus(body.layout.status);
      setVersion(body.layout.version);
    } finally {
      setPublishing(false);
    }
  }

  async function openPdf() {
    setPdfBusy(true);
    try {
      const res = await fetch("/api/admin/output-layouts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: def, layoutId: layout.id, styleId: testStyle?.id, format: "pdf" }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } finally {
      setPdfBusy(false);
    }
  }

  function openJsonPanel() {
    setJsonText(JSON.stringify(def, null, 2));
    setJsonError(null);
    setJsonOpen(true);
  }

  function applyJson() {
    setJsonError(null);
    try {
      const parsed = LayoutDefSchema.safeParse(JSON.parse(jsonText));
      if (!parsed.success) {
        setJsonError(parsed.error.issues.map((i) => i.message).slice(0, 3).join(" · "));
        return;
      }
      setDef(parsed.data);
      setSel(null);
    } catch (err) {
      setJsonError(`Not valid JSON: ${(err as Error).message}`);
    }
  }

  // Wrap the textarea selection with inline markers (**bold** / _italic_).
  function wrapSelection(marker: string) {
    if (!selBlock) return;
    const ta = contentTaRef.current;
    if (!ta) return;
    const text = selBlock.lines.join("\n");
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const selected = text.slice(start, end) || "text";
    const next = text.slice(0, start) + marker + selected + marker + text.slice(end);
    updateBlock(blockId(selBlock), { lines: next.split("\n").slice(0, 100) });
    const caret = start + marker.length + selected.length + marker.length;
    window.setTimeout(() => {
      const el = contentTaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    }, 0);
  }

  function insertToken(token: string) {
    if (!selBlock || !page) return;
    const ta = contentTaRef.current;
    const text = selBlock.lines.join("\n");
    let next: string;
    let caret: number;
    if (ta && document.activeElement === ta) {
      const start = ta.selectionStart ?? text.length;
      const end = ta.selectionEnd ?? text.length;
      next = text.slice(0, start) + token + text.slice(end);
      caret = start + token.length;
    } else {
      next = text.length > 0 ? `${text}\n${token}` : token;
      caret = next.length;
    }
    updateBlock(blockId(selBlock), { lines: next.split("\n").slice(0, 100) });
    window.setTimeout(() => {
      const el = contentTaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    }, 0);
  }

  // ---- canvas geometry ---------------------------------------------------

  // Cheap derived math — no memo (keeps the React Compiler happy).
  const scale = page ? Math.min(Math.max(Math.min(560 / page.widthMm, 380 / page.heightMm), 1), 6) : 3;

  const orientation = page && page.heightMm > page.widthMm ? "portrait" : "landscape";

  function setOrientation(target: "portrait" | "landscape") {
    if (!page || orientation === target) return;
    updatePage({ widthMm: page.heightMm, heightMm: page.widthMm });
  }

  if (!page) return null;

  const ghost = draw
    ? {
        col: Math.min(draw.startCol, draw.curCol),
        row: Math.min(draw.startRow, draw.curRow),
        colSpan: Math.abs(draw.curCol - draw.startCol) + 1,
        rowSpan: Math.abs(draw.curRow - draw.startRow) + 1,
      }
    : null;

  // Blocks listed in reading order (top→bottom, then left→right) so the
  // Blocks panel mirrors how the label reads — easier to scan than the
  // crammed canvas. Display order only; selection/identity stay keyed by id.
  const orderedBlocks = [...page.blocks].sort((a, b) => {
    const ra = a.rect;
    const rb = b.rect;
    if (!ra || !rb) return 0;
    return ra.row - rb.row || ra.col - rb.col;
  });

  return (
    <div className="min-h-screen bg-white">
      {/* ---------- header ---------- */}
      <div className="sticky top-0 z-20 border-b border-zinc-200 bg-white/95 px-8 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/output-builder" className="text-sm text-zinc-400 hover:text-zinc-700">
            ← Output builder
          </Link>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-80 rounded-md border border-transparent px-2 py-1 text-base font-semibold tracking-tight hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
          />
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600"
            title="Asset doc type — grouping in pickers and on JobAssets"
          >
            {docTypes.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
            {docTypes.some((d) => d.value === docType) ? null : (
              <option value={docType}>{docType}</option>
            )}
          </select>
          <Link
            href="/output-builder?docTypes=1"
            className="text-[11px] text-zinc-400 underline-offset-2 hover:text-zinc-600 hover:underline"
            title="Add or rename document types, set keyword exclusion rules"
          >
            Manage types
          </Link>
          <label
            className="flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600"
            title="Info area: this layout's print size becomes switchable per style (admin size or custom) on the Style page — see Settings → Info area sizes"
          >
            <input
              type="checkbox"
              checked={isInfoArea}
              onChange={(e) => setIsInfoArea(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
            />
            Info area
          </label>
          {status === "PUBLISHED" ? (
            <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              Published · v{version} — edits go live on save
            </span>
          ) : (
            <span className="inline-flex rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium text-zinc-500">
              Draft
            </span>
          )}
          <span className="text-xs text-zinc-400">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "dirty"
                ? "Unsaved changes"
                : saveState === "error"
                  ? `Save failed${saveError ? ` — ${saveError}` : ""}`
                  : savedAt
                    ? `Saved · ${savedAt}`
                    : ""}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              aria-label="Output Builder guide"
              title="Output Builder guide — what every control does and how to use it"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-300 bg-white text-sm font-semibold text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-800"
            >
              ?
            </button>
            <button
              type="button"
              onClick={saveNow}
              disabled={saveState === "saved" || saveState === "saving"}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              title="Save now (autosave runs 1.2s after the last change)"
            >
              {saveState === "saving" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={openPdf}
              disabled={pdfBusy}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
            >
              {pdfBusy ? "Rendering…" : "Open PDF"}
            </button>
            {status === "DRAFT" ? (
              <button
                type="button"
                onClick={publish}
                disabled={publishing}
                className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
              >
                {publishing ? "Publishing…" : "Publish"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="ml-1 border-l border-zinc-200 pl-3 text-sm font-medium text-zinc-400 hover:text-red-600"
              title="Delete this layout"
            >
              Delete
            </button>
          </div>
        </div>
        {publishErrors.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-xs text-red-600">
            {publishErrors.map((e, i) => (
              <li key={i}>· {e}</li>
            ))}
          </ul>
        ) : null}
        {status === "PUBLISHED" ? (
          <p className="mt-1.5 text-xs text-zinc-400">
            Available in the Prod Spec output picker as{" "}
            <code className="rounded bg-zinc-100 px-1 font-mono">layout:{layout.id}</code> — it only generates for
            styles once added to a Prod Spec there.
          </p>
        ) : null}
      </div>

      {confirmDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deleting) setConfirmDelete(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-900">Delete “{name}”?</h2>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm text-zinc-600">
              {prodSpecs.length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                  <p className="font-medium">
                    Removes the output from {prodSpecs.length} prod spec{prodSpecs.length === 1 ? "" : "s"}:
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {prodSpecs.slice(0, 8).map((s) => (
                      <li key={s.id} className="truncate">
                        {s.name} <span className="text-amber-600">· {s.customerName}</span>
                      </li>
                    ))}
                    {prodSpecs.length > 8 ? (
                      <li className="text-amber-600">+{prodSpecs.length - 8} more</li>
                    ) : null}
                  </ul>
                </div>
              ) : (
                <p className="text-zinc-500">Not linked to any prod spec.</p>
              )}
              <p className="text-xs text-zinc-400">
                Already-generated PDFs are kept — only the prod-spec link is removed.
              </p>
              {deleteError ? <p className="text-xs text-red-600">{deleteError}</p> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteLayout}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- guide drawer ---------- */}
      {guideOpen ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          role="dialog"
          aria-modal="true"
          aria-label="Output Builder guide"
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="flex h-full w-full max-w-[46rem] flex-col bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3">
              <div className="text-sm font-semibold tracking-tight text-zinc-900">
                Output Builder — guide
              </div>
              <div className="ml-auto flex items-center gap-2">
                <a
                  href="/guides/output-builder"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                  title="Open the full guide page (with PDF download) in a new tab"
                >
                  Pop out ↗
                </a>
                <button
                  type="button"
                  onClick={() => setGuideOpen(false)}
                  aria-label="Close guide"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  ✕
                </button>
              </div>
            </div>
            <iframe
              src="/guides/admin-output-builder.html"
              title="Output Builder guide"
              className="min-h-0 flex-1 border-0"
            />
          </div>
        </div>
      ) : null}

      {/* ---------- tabs ---------- */}
      <div className="flex items-center gap-6 border-b border-zinc-200 px-8">
        {([
          ["customizer", "Customizer"],
          ["reviews", "Reviews"],
          ["settings", "Settings"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-1 py-2.5 text-sm font-medium transition-colors ${
              tab === key
                ? "border-zinc-900 text-zinc-900"
                : "border-transparent text-zinc-400 hover:text-zinc-700"
            }`}
          >
            {label}
            {key === "reviews" && stats.pendingReview > 0 ? (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-px text-[11px] font-semibold text-amber-700">
                {stats.pendingReview}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ===== Customizer tab — canvas lives here, always ===== */}
      <div className={tab === "customizer" ? undefined : "hidden"}>
      {/* ---------- test data ---------- */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-8 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Test data</span>
        <select
          value={customerId ?? ""}
          onChange={(e) => setCustomerId(e.target.value || null)}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-700"
        >
          <option value="">Customer…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={businessAreaId ?? ""}
          onChange={(e) => setBusinessAreaId(e.target.value || null)}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-700"
        >
          <option value="">Business area…</option>
          {businessAreas.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        {customerId && businessAreaId ? (
          <>
            <div className="relative">
              <input
                type="text"
                value={styleQuery}
                onChange={(e) => {
                  setStyleQuery(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
                placeholder="Search style / PO…"
                className="w-44 rounded-md border border-zinc-200 bg-white py-1 pl-2 pr-6 text-sm text-zinc-700 placeholder:text-zinc-300"
              />
              {styleQuery ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setStyleQuery("");
                    setSearchOpen(false);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-zinc-300 hover:text-zinc-600"
                  title="Clear search"
                >
                  ✕
                </button>
              ) : null}
              {searchOpen && styleQuery.trim() && styles.length > 0 ? (
                <div className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-md">
                  {styles.slice(0, 10).map((s, i) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setStyleIdx(i);
                        setSearchOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-zinc-50 ${
                        i === styleIdx ? "bg-zinc-50" : ""
                      }`}
                    >
                      <span className="truncate font-medium text-zinc-800">{s.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {s.poNumber ? <span className="font-mono text-[11px] text-zinc-400">{s.poNumber}</span> : null}
                        <span
                          className={`rounded-full px-1.5 py-px text-[11px] font-medium ${
                            s.total > 0 && s.missing.length === 0
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {s.filled}/{s.total}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {stylesLoading ? (
              <span className="text-xs text-zinc-400">{styleQuery.trim() ? "Searching…" : "Finding fullest styles…"}</span>
            ) : styles.length === 0 ? (
              <span className="text-xs text-zinc-400">
                {styleQuery.trim() ? `No styles match “${styleQuery.trim()}”` : "No styles for this pair"}
              </span>
            ) : (
              <>
                <div className="flex items-center gap-1 rounded-md border border-zinc-200 px-1 py-0.5">
                  <button
                    type="button"
                    onClick={() => setStyleIdx((i) => (i + styles.length - 1) % styles.length)}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100"
                    title="Previous style"
                  >
                    ◀
                  </button>
                  <span className="max-w-64 truncate px-1 text-sm font-medium text-zinc-800" title={testStyle?.name}>
                    {testStyle?.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setStyleIdx((i) => (i + 1) % styles.length)}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100"
                    title="Next style"
                  >
                    ▶
                  </button>
                </div>
                {testStyle ? (
                  testStyle.total === 0 ? (
                    <span className="text-xs text-zinc-400">no variables yet</span>
                  ) : testStyle.missing.length === 0 ? (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {testStyle.filled}/{testStyle.total} fields
                    </span>
                  ) : (
                    <span
                      className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                      title={`Missing: ${testStyle.missing.join(", ")}`}
                    >
                      {testStyle.filled}/{testStyle.total} fields · missing {testStyle.missing.join(", ")}
                    </span>
                  )
                ) : null}
                <span className="text-xs text-zinc-300">
                  {styleIdx + 1} of {styles.length}
                  {styleQuery.trim() ? ` match${styles.length === 1 ? "" : "es"}` : ""}, fullest first
                </span>
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-zinc-400">Pick a customer and business area to preview with real styles</span>
        )}
      </div>

      {/* ---------- main ---------- */}
      <div className="grid grid-cols-1 gap-8 px-8 py-6 lg:grid-cols-[12.5rem_minmax(0,1fr)_19rem]">
        {/* ----- left: pages ----- */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Pages</div>
          <div className="mt-2 flex flex-col gap-1.5">
            {def.pages.map((p, i) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setPageIdx(i);
                  setSel(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPageIdx(i);
                    setSel(null);
                  }
                }}
                className={`group relative cursor-pointer rounded-md border px-3 py-2 text-left ${
                  i === pageIdx ? "border-zinc-900 bg-white" : "border-zinc-200 bg-white hover:border-zinc-300"
                }`}
              >
                <div className="pr-4 text-sm font-medium text-zinc-800">
                  {i + 1} · {p.title || "Untitled"}
                </div>
                <div className="font-mono text-[11px] text-zinc-400">
                  {p.widthMm} × {p.heightMm} mm
                </div>
                {p.omitWhenEmpty ? (
                  <div
                    className="text-[10px] font-medium text-amber-600"
                    title="This page is left out of the PDF when nothing on it resolves for the style"
                  >
                    skips when empty
                  </div>
                ) : null}
                {def.pages.length > 1 ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removePage(i);
                    }}
                    className="absolute right-1.5 top-1.5 hidden h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none text-zinc-300 hover:bg-red-50 hover:text-red-600 group-hover:flex"
                    title={`Delete page "${p.title || "Untitled"}"`}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              onClick={addPage}
              className="rounded-md border border-dashed border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-zinc-400 hover:text-zinc-600"
            >
              + Add page
            </button>
          </div>

          <div className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Page settings</div>
          <div className="mt-2 space-y-3">
            <div>
              <label className="text-xs text-zinc-500">Title</label>
              <input
                type="text"
                value={page.title}
                onChange={(e) => updatePage({ title: e.target.value })}
                className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-zinc-500">Width mm</label>
                <input
                  type="number"
                  min={5}
                  max={1000}
                  value={page.widthMm}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 5 && v <= 1000) updatePage({ widthMm: v });
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm tabular-nums"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-zinc-500">Height mm</label>
                <input
                  type="number"
                  min={5}
                  max={1000}
                  value={page.heightMm}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 5 && v <= 1000) updatePage({ heightMm: v });
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm tabular-nums"
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-zinc-500">Margins mm</label>
                <button
                  type="button"
                  onClick={() => {
                    if (marginsLinked) {
                      setMarginsLinked(false);
                    } else {
                      const v = page.margins?.topMm ?? 0;
                      updatePage({ margins: { topMm: v, rightMm: v, bottomMm: v, leftMm: v } });
                      setMarginsLinked(true);
                    }
                  }}
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                    marginsLinked
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                  }`}
                  title={marginsLinked ? "Linked — one value for all sides. Click to edit each side." : "Per side. Click to link all sides."}
                >
                  {marginsLinked ? "🔗 linked" : "per side"}
                </button>
              </div>
              {marginsLinked ? (
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={page.margins?.topMm ?? 0}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0 && v <= 50)
                      updatePage({ margins: { topMm: v, rightMm: v, bottomMm: v, leftMm: v } });
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm tabular-nums"
                />
              ) : (
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ["topMm", "Top"],
                      ["rightMm", "Right"],
                      ["bottomMm", "Bottom"],
                      ["leftMm", "Left"],
                    ] as const
                  ).map(([k, label]) => (
                    <div key={k}>
                      <label className="text-[10px] text-zinc-400">{label}</label>
                      <input
                        type="number"
                        min={0}
                        max={50}
                        step={0.5}
                        value={page.margins?.[k] ?? 0}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0 && v <= 50)
                            updatePage({
                              margins: {
                                ...(page.margins ?? { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 }),
                                [k]: v,
                              },
                            });
                        }}
                        className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm tabular-nums"
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-0.5 text-[10px] text-zinc-400">The grid (and all blocks) inset from the page edges.</p>
            </div>
            <div>
              <label className="text-xs text-zinc-500">Orientation</label>
              <div className="mt-1 flex overflow-hidden rounded-md border border-zinc-200">
                {(["portrait", "landscape"] as const).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setOrientation(o)}
                    className={`flex-1 px-2 py-1 text-xs font-medium capitalize ${
                      orientation === o ? "bg-zinc-900 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
            {/* Conditional page — the certificate-page case: a page whose only
                content is a gated mark prints blank on every style that
                doesn't declare it. With this on, the page is left out of the
                PDF instead. Opt-in per page: a deliberately blank page (a
                plain back side) must keep printing as authored. */}
            <div>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={!!page?.omitWhenEmpty}
                  onChange={(e) => updatePage({ omitWhenEmpty: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                />
                Skip page when empty
              </label>
              <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-400">
                Leaves this page out of the printed PDF when nothing on it resolves for the style — a
                page whose only content is <span className="font-mono">{"{{cert:oekotex}}"}</span>{" "}
                disappears on styles without OEKO-TEX instead of printing blank. Borders and guides
                don&apos;t count as content, and the preview always shows the page.
              </p>
            </div>
            {def.pages.length > 1 ? (
              <button
                type="button"
                onClick={() => removePage(pageIdx)}
                className="text-xs text-zinc-400 hover:text-red-600"
              >
                Remove this page
              </button>
            ) : null}
          </div>

          <div className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Grid</div>
          <div className="mt-2 space-y-2">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="text-xs text-zinc-500">Cell size (mm)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={gridCellMm}
                  onChange={(e) => setGridCellMm(e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm tabular-nums"
                  placeholder={String(DEFAULT_GRID_CELL_MM)}
                />
              </div>
              <button
                type="button"
                onClick={regenerateGrid}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                title="Recompute cols × rows from this cell size and remap existing blocks"
              >
                Regenerate
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-zinc-400">
              Current grid <span className="font-mono text-zinc-500">{grid.cols} × {grid.rows}</span>
              {page ? (
                <>
                  {" "}
                  · ≈ {(page.widthMm / grid.cols).toFixed(1)} × {(page.heightMm / grid.rows).toFixed(1)} mm per cell
                </>
              ) : null}
              . Regenerate keeps existing blocks, adjusting any that no longer fit.
            </p>
          </div>

          <div className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Print guides</div>
          <div className="mt-2 space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-zinc-500">Sewing lines</label>
                <button
                  type="button"
                  onClick={addSewingLine}
                  className="text-xs font-medium text-zinc-700 hover:text-zinc-900"
                >
                  + Add
                </button>
              </div>
              {sewingLines.length === 0 ? (
                <p className="mt-1 text-[10px] text-zinc-400">
                  A solid rule a fixed distance from the top or bottom edge (the seam allowance).
                </p>
              ) : (
                <div className="mt-1.5 space-y-1.5">
                  {sewingLines.map((s, i) => (
                    // Inputs remount when the list length changes (key carries it),
                    // so an uncontrolled offset field re-reads the right value after
                    // add/remove while still letting you type a "7,5" decimal freely.
                    <div key={`sew-${sewingLines.length}-${i}`} className="flex items-center gap-1.5">
                      <select
                        value={s.edge}
                        onChange={(e) => updateSewingLine(i, { edge: e.target.value as SewingLine["edge"] })}
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700"
                      >
                        <option value="top">From top</option>
                        <option value="bottom">From bottom</option>
                      </select>
                      <input
                        type="text"
                        inputMode="decimal"
                        defaultValue={String(s.offsetMm).replace(".", ",")}
                        onChange={(e) => {
                          const v = parseMm(e.target.value);
                          if (Number.isFinite(v) && v >= 0 && v <= 1000) updateSewingLine(i, { offsetMm: v });
                        }}
                        className="w-16 rounded-md border border-zinc-200 px-2 py-1 text-xs tabular-nums"
                        aria-label="Offset from edge (mm)"
                      />
                      <span className="text-[10px] text-zinc-400">mm</span>
                      <button
                        type="button"
                        onClick={() => removeSewingLine(i)}
                        className="ml-auto text-zinc-300 hover:text-red-600"
                        aria-label="Remove sewing line"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-zinc-500">Folding line</label>
              <select
                value={page?.foldLine ?? "none"}
                onChange={(e) => setFoldLine(e.target.value as FoldLine)}
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700"
              >
                <option value="none">Off</option>
                <option value="horizontal">Horizontal — across centre</option>
                <option value="vertical">Vertical — down centre</option>
              </select>
              <p className="mt-0.5 text-[10px] text-zinc-400">A dashed rule through the page centre.</p>
            </div>

            {/* Page border — a frame around the WHOLE page, so a design
                doesn't need an empty full-page block just to get an
                outline. Decorative only: no tokens, no grid cells. */}
            <div>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={!!pageBorder}
                  onChange={(e) => togglePageBorder(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                />
                Page border
              </label>
              {pageBorder ? (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    defaultValue={String(pageBorder.widthMm).replace(".", ",")}
                    onChange={(e) => {
                      const v = parseMm(e.target.value);
                      if (Number.isFinite(v) && v >= 0.1 && v <= 5) updatePageBorder({ widthMm: v });
                    }}
                    className="w-14 rounded-md border border-zinc-200 px-2 py-1 text-xs tabular-nums"
                    aria-label="Border thickness (mm)"
                  />
                  <span className="text-[10px] text-zinc-400">thick</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    defaultValue={String(pageBorder.insetMm).replace(".", ",")}
                    onChange={(e) => {
                      const v = parseMm(e.target.value);
                      if (Number.isFinite(v) && v >= 0 && v <= 50) updatePageBorder({ insetMm: v });
                    }}
                    className="w-14 rounded-md border border-zinc-200 px-2 py-1 text-xs tabular-nums"
                    aria-label="Inset from page edge (mm)"
                  />
                  <span className="text-[10px] text-zinc-400">inset</span>
                  <input
                    type="color"
                    value={pageBorder.color}
                    onChange={(e) => updatePageBorder({ color: e.target.value })}
                    className="ml-auto h-6 w-8 cursor-pointer rounded border border-zinc-200 bg-white p-0.5"
                    aria-label="Border colour"
                  />
                </div>
              ) : (
                <p className="mt-0.5 text-[10px] text-zinc-400">
                  Frames the whole page — thickness, inset from the edge and colour, in mm.
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Settings</div>
          <div className="mt-2 space-y-3">
            <div>
              <label className="text-xs text-zinc-500">Repeat output</label>
              <select
                value={settings.repeatBy}
                onChange={(e) => updateSettings({ repeatBy: e.target.value as LayoutSettings["repeatBy"] })}
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700"
              >
                <option value="none">Don&apos;t repeat</option>
                <option value="size">Per size</option>
                <option value="ean">Per EAN (size × colour)</option>
                <option value="assort">Per assortment EAN</option>
                <option value="cartonEan">Per carton EAN (per size + assort)</option>
              </select>
              {settings.repeatBy !== "none" ? (
                <p className="mt-1.5 break-words font-mono text-[10px] leading-relaxed text-zinc-400">
                  {repeatValues.length > 0 ? (
                    <>
                      <span className="font-sans font-medium text-zinc-500">
                        {repeatValues.length} repetition{repeatValues.length === 1 ? "" : "s"}:{" "}
                      </span>
                      {repeatValues.join(", ")}
                    </>
                  ) : (
                    "No sizes on the selected test style — output renders once."
                  )}
                </p>
              ) : null}
            </div>
            {settings.repeatBy !== "none" ? (
              <div>
                <label className="text-xs text-zinc-500">Output files</label>
                <select
                  value={settings.splitBy}
                  onChange={(e) => updateSettings({ splitBy: e.target.value as LayoutSettings["splitBy"] })}
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700"
                >
                  <option value="ean">One PDF per EAN</option>
                  <option value="none">One single PDF (all repetitions inside)</option>
                </select>
                {repeatValues.length > 0 ? (
                  <p className="mt-1 text-[10px] text-zinc-400">
                    {settings.splitBy === "ean"
                      ? `→ ${repeatValues.length} file${repeatValues.length === 1 ? "" : "s"}, each containing only its own EAN`
                      : `→ 1 file containing all ${repeatValues.length} repetition${repeatValues.length === 1 ? "" : "s"}`}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div>
              <label className="text-xs text-zinc-500">Output file name</label>
              <input
                type="text"
                value={settings.fileName}
                onChange={(e) => updateSettings({ fileName: e.target.value })}
                placeholder="{{styleNumber}}-{{size}}-sticker"
                className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 font-mono text-xs"
                spellCheck={false}
              />
              <p className="mt-1 text-[10px] text-zinc-400">
                {settings.fileName ? (
                  resolvedFileName ? (
                    <>
                      → <span className="font-mono text-emerald-700">{resolvedFileName}</span>
                    </>
                  ) : (
                    "Resolving…"
                  )
                ) : settings.repeatBy !== "none" && settings.splitBy === "ean" ? (
                  "Variables allowed — {{size}}/{{ean13}}/{{colourName}} name EACH file (one per EAN)"
                ) : (
                  "Text variables allowed · empty = default name"
                )}
              </p>

              {/* Preset library — shared across layouts (AppSetting), grown
                  by whoever needs a new convention. Clicking one pastes its
                  pattern into the field above; nothing is applied silently. */}
              <div className="mt-2 rounded-md border border-zinc-100 bg-zinc-50/70 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Presets</span>
                  <button
                    type="button"
                    onClick={saveFileNamePreset}
                    disabled={presetBusy || !settings.fileName.trim()}
                    className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-300"
                    title={
                      settings.fileName.trim()
                        ? "Save the current file name as a reusable preset"
                        : "Type a file name first"
                    }
                  >
                    + Save current
                  </button>
                </div>
                {fileNamePresets.length === 0 ? (
                  <p className="mt-1 text-[10px] text-zinc-400">
                    No presets yet — type a file name and save it to reuse it on other layouts.
                  </p>
                ) : (
                  <div className="mt-1.5 space-y-1">
                    {fileNamePresets.map((p) => {
                      const active = settings.fileName === p.pattern;
                      return (
                        <div key={p.id} className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => updateSettings({ fileName: p.pattern })}
                            className={`min-w-0 flex-1 rounded border px-1.5 py-1 text-left ${
                              active
                                ? "border-zinc-300 bg-white"
                                : "border-transparent hover:border-zinc-200 hover:bg-white"
                            }`}
                            title={p.pattern}
                          >
                            <span className="block truncate text-[11px] text-zinc-700">{p.label}</span>
                            <span className="block truncate font-mono text-[10px] text-zinc-400">{p.pattern}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteFileNamePreset(p)}
                            disabled={presetBusy}
                            className="text-zinc-300 hover:text-red-600 disabled:hover:text-zinc-300"
                            aria-label={`Remove preset ${p.label}`}
                            title="Remove preset"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Carton numbering (X/Y) — eligibility only; standard
                generation is untouched. Surfaces the {{cartonNo}} /
                {{cartonTotal}} tokens and the Style-page "Carton numbers…"
                action. */}
            <div className="border-t border-zinc-100 pt-3">
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={settings.cartonNumbering}
                  onChange={(e) => updateSettings({ cartonNumbering: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                />
                Carton numbering (X/Y)
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
                Lets operators print a numbered set (1/N … N/N) from the Style page. Place{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{cartonNo}}"}</code> /{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{cartonTotal}}"}</code> on the label.
              </p>
              {settings.cartonNumbering && !usesCartonTokens ? (
                <p className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] leading-relaxed text-amber-700">
                  ⚠ This layout doesn’t use {"{{cartonNo}}"}/{"{{cartonTotal}}"} yet — numbered prints
                  would show no number.
                </p>
              ) : null}
            </div>

            {/* Multiple styles (Custom Carton Marking) — INDEPENDENT of
                carton numbering. Eligibility only; standard generation stays
                single-style. Surfaces the {{style2}}… slots + {{multipleStyles}}
                and lets the Style-page carton dialog pick same-PO siblings. */}
            <div className="border-t border-zinc-100 pt-3">
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={settings.multipleStyles}
                  onChange={(e) => updateSettings({ multipleStyles: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                />
                Multiple styles on the box
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
                Lets operators place OTHER styles from the same PO on the box (a manual one-off).
                Branch with{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{if multipleStyles == true}}"}</code>{" "}
                and place{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{style2}}"}</code> /{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{style2Number}}"}</code> slots.
              </p>
            </div>

            {/* Custom logo — appears only when the design uses
                {{logo:custom}}. Uploaded per layout (not global); printed at
                a % of its block width, height auto. */}
            {usesCustomLogo ? (
              <div className="border-t border-zinc-100 pt-3">
                <div className="text-sm text-zinc-700">
                  Custom logo <span className="font-mono text-[11px] text-zinc-400">{"{{logo:custom}}"}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {customLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={customLogo}
                      alt="Custom logo"
                      className="h-8 w-auto max-w-[7rem] rounded border border-zinc-200 bg-white object-contain p-0.5"
                    />
                  ) : (
                    <span className="text-[11px] text-zinc-400">none uploaded</span>
                  )}
                  <label
                    className={`cursor-pointer rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 ${
                      logoBusy ? "opacity-50" : ""
                    }`}
                  >
                    {customLogo ? "Replace" : "Upload (SVG/PNG/JPG)"}
                    <input
                      type="file"
                      accept="image/svg+xml,image/png,image/jpeg"
                      className="hidden"
                      disabled={logoBusy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadCustomLogo(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {customLogo ? (
                    <button
                      type="button"
                      onClick={() => void removeCustomLogo()}
                      disabled={logoBusy}
                      className="text-xs text-zinc-400 hover:text-red-600 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                {logoError ? <p className="mt-1 text-[10px] text-red-600">{logoError}</p> : null}

                <div className="mt-3">
                  <div className="flex items-baseline justify-between">
                    <label className="text-xs text-zinc-500">Logo width</label>
                    <span className="font-mono text-[11px] text-zinc-400">{settings.customLogoWidthPct}%</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={settings.customLogoWidthPct}
                    onChange={(e) => updateSettings({ customLogoWidthPct: Number(e.target.value) })}
                    className="mt-1 w-full accent-zinc-900"
                  />
                  <p className="mt-0.5 text-[10px] text-zinc-400">% of the block&rsquo;s width — height scales to keep the aspect ratio.</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* ----- center: canvas + preview ----- */}
        <div className="min-w-0">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Canvas</div>
            <div className="font-mono text-[11px] text-zinc-400">
              {page.widthMm} × {page.heightMm} mm · {orientation} · grid {grid.cols} × {grid.rows}
            </div>
          </div>
          <div className="mt-2 flex justify-center rounded-lg border border-zinc-200 bg-zinc-50/60 px-6 py-10">
            <div
              ref={canvasRef}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              className="relative touch-none border border-zinc-300 bg-white shadow-sm"
              style={{
                width: page.widthMm * scale,
                height: page.heightMm * scale,
                cursor: draw ? "crosshair" : "default",
              }}
            >
              {/* grid overlay — inset by the page margin */}
              <div
                className="pointer-events-none absolute"
                style={{
                  left: gridGeom(page, scale).left,
                  top: gridGeom(page, scale).top,
                  width: gridGeom(page, scale).width,
                  height: gridGeom(page, scale).height,
                  outline:
                    (page.margins?.topMm ?? 0) + (page.margins?.rightMm ?? 0) + (page.margins?.bottomMm ?? 0) + (page.margins?.leftMm ?? 0) > 0
                      ? "1px dashed rgba(24,24,27,0.12)"
                      : "none",
                  backgroundImage:
                    `repeating-linear-gradient(to right, transparent 0, transparent calc(${100 / grid.cols}% - 1px), rgba(24,24,27,0.045) calc(${100 / grid.cols}% - 1px), rgba(24,24,27,0.045) ${100 / grid.cols}%),` +
                    `repeating-linear-gradient(to bottom, transparent 0, transparent calc(${100 / grid.rows}% - 1px), rgba(24,24,27,0.045) calc(${100 / grid.rows}% - 1px), rgba(24,24,27,0.045) ${100 / grid.rows}%)`,
                }}
              />
              {/* Page border preview — same geometry as the renderer's
                  frame (inset in mm, scaled to the canvas). */}
              {pageBorder ? (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: pageBorder.insetMm * scale,
                    top: pageBorder.insetMm * scale,
                    right: pageBorder.insetMm * scale,
                    bottom: pageBorder.insetMm * scale,
                    border: `${Math.max(1, pageBorder.widthMm * scale)}px solid ${pageBorder.color}`,
                  }}
                  title="Page border"
                />
              ) : null}
              {page.blocks.map((block) => (
                <CanvasBlock
                  key={blockId(block)}
                  block={block}
                  page={page}
                  scale={scale}
                  selected={sel === blockId(block)}
                  highlighted={hoverBlock === blockId(block)}
                  onSelect={() => setSel(blockId(block))}
                  onRemove={() => removeBlock(blockId(block))}
                />
              ))}
              {/* Print-guide overlays — full page width/height, matching the
                  true render. Sewing solid, fold dashed. */}
              {sewingLines.map((s, i) => (
                <div
                  // eslint-disable-next-line react/no-array-index-key
                  key={`csew-${i}`}
                  className="pointer-events-none absolute"
                  style={{
                    left: 0,
                    width: page.widthMm * scale,
                    top: (s.edge === "bottom" ? page.heightMm - s.offsetMm : s.offsetMm) * scale,
                    borderTop: "1px solid rgba(24,24,27,0.7)",
                  }}
                  title={`Sewing line — ${String(s.offsetMm).replace(".", ",")} mm from ${s.edge}`}
                />
              ))}
              {page.foldLine === "horizontal" ? (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: 0,
                    width: page.widthMm * scale,
                    top: (page.heightMm / 2) * scale,
                    borderTop: "1px dashed rgba(82,82,91,0.9)",
                  }}
                  title="Folding line — horizontal centre"
                />
              ) : null}
              {page.foldLine === "vertical" ? (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    top: 0,
                    height: page.heightMm * scale,
                    left: (page.widthMm / 2) * scale,
                    borderLeft: "1px dashed rgba(82,82,91,0.9)",
                  }}
                  title="Folding line — vertical centre"
                />
              ) : null}
              {ghost ? (
                <div
                  className="pointer-events-none absolute rounded-sm border border-zinc-900/50 bg-zinc-900/5"
                  style={{
                    left: gridGeom(page, scale).left + (ghost.col / grid.cols) * gridGeom(page, scale).width,
                    top: gridGeom(page, scale).top + (ghost.row / grid.rows) * gridGeom(page, scale).height,
                    width: (ghost.colSpan / grid.cols) * gridGeom(page, scale).width,
                    height: (ghost.rowSpan / grid.rows) * gridGeom(page, scale).height,
                  }}
                />
              ) : null}
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-zinc-400">
            <b className="font-medium text-zinc-500">Drag on the grid</b> to draw a block exactly where you want it ·
            click a block to edit · Del removes the selected block
          </p>

          {/* true render preview */}
          <div className="mt-8">
            <div className="flex items-baseline justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Print preview — true render{previewSample ? " · sample data" : testStyle ? ` · ${testStyle.name}` : ""}
              </div>
              {unresolved.length > 0 ? (
                <span className="text-xs text-amber-700">
                  {unresolved.length} unresolved: {unresolved.join(" ")}
                </span>
              ) : previewHtml ? (
                <span className="text-xs text-emerald-700">all variables resolved</span>
              ) : null}
            </div>
            {settings.cartonNumbering ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800">
                <span className="font-medium">Preview as carton</span>
                <input
                  type="number"
                  min={1}
                  max={cartonPreviewTotal}
                  value={cartonPreviewNo}
                  onChange={(e) =>
                    setCartonPreviewNo(Math.min(cartonPreviewTotal, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className="w-16 rounded border border-amber-300 bg-white px-2 py-1 text-center tabular-nums text-amber-900"
                />
                <span>of</span>
                <input
                  type="number"
                  min={1}
                  value={cartonPreviewTotal}
                  onChange={(e) => {
                    const total = Math.max(1, Number(e.target.value) || 1);
                    setCartonPreviewTotal(total);
                    if (cartonPreviewNo > total) setCartonPreviewNo(total);
                  }}
                  className="w-20 rounded border border-amber-300 bg-white px-2 py-1 text-center tabular-nums text-amber-900"
                />
                <span className="text-amber-700/80">— injects the running number into the preview.</span>
              </div>
            ) : null}
            <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-6">
              {previewHtml ? (
                <div className="mx-auto" style={{ maxWidth: Math.max(page.widthMm * 3.78, 280) }}>
                  <PreviewFrame html={previewHtml} widthMm={page.widthMm} heightMm={page.heightMm} />
                </div>
              ) : (
                <p className="py-10 text-center text-xs text-zinc-400">Rendering…</p>
              )}
            </div>
            <p className="mt-2 text-xs text-zinc-400">
              Rendered by the same code that generates the production PDF — empty variables show as amber chips here
              and never print.
            </p>
          </div>
        </div>

        {/* ----- right: blocks + inspector + variables ----- */}
        <div className="space-y-5">
          {/* Blocks on this page — a navigable list. Click a row to select
              (far easier than hunting a tiny block on the canvas); hover to
              flash that block's position with a blue locator ring; the row
              ✕ deletes it. Stays in sync with the canvas selection. */}
          <div className="rounded-lg border border-zinc-200 p-4">
            <div className="flex items-baseline justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Blocks</div>
              <span className="text-[11px] tabular-nums text-zinc-400">{page.blocks.length}</span>
            </div>
            {page.blocks.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-400">No blocks yet — drag on the grid to draw one.</p>
            ) : (
              <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto pr-0.5">
                {orderedBlocks.map((b) => {
                  const id = blockId(b);
                  const isSel = sel === id;
                  const { kind, text, extra } = blockSummary(b);
                  return (
                    <li key={id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setSel(id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSel(id);
                          }
                        }}
                        onMouseEnter={() => setHoverBlock(id)}
                        onMouseLeave={() => setHoverBlock((h) => (h === id ? null : h))}
                        onFocus={() => setHoverBlock(id)}
                        onBlur={() => setHoverBlock((h) => (h === id ? null : h))}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 ${
                          isSel
                            ? "border-zinc-900 bg-zinc-50"
                            : "border-transparent hover:border-zinc-200 hover:bg-zinc-50"
                        }`}
                      >
                        {kind ? (
                          <span className="shrink-0 rounded bg-zinc-100 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-zinc-500">
                            {kind}
                          </span>
                        ) : null}
                        <span className={`min-w-0 flex-1 truncate text-xs ${isSel ? "text-zinc-900" : "text-zinc-600"}`}>
                          {text}
                        </span>
                        {extra > 0 ? (
                          <span className="shrink-0 text-[10px] text-zinc-300" title={`${extra + 1} lines`}>
                            +{extra}
                          </span>
                        ) : null}
                        {b.rect ? (
                          <span className="shrink-0 font-mono text-[10px] text-zinc-300 group-hover:hidden">
                            R{b.rect.row + 1}·C{b.rect.col + 1}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeBlock(id);
                          }}
                          className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none text-zinc-300 hover:bg-red-50 hover:text-red-600 group-hover:flex"
                          title="Delete this block"
                          aria-label="Delete block"
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <div className="flex items-baseline justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Block
              </div>
              {selBlock ? (
                <button
                  type="button"
                  onClick={() => removeBlock(blockId(selBlock))}
                  className="text-[11px] font-medium text-zinc-400 hover:text-red-600"
                  title="Delete this block (or press Del with it selected)"
                >
                  Delete
                </button>
              ) : null}
            </div>
            {!selBlock ? (
              <p className="mt-2 text-xs text-zinc-400">
                Select a block on the canvas, or drag on the grid to draw a new one.
              </p>
            ) : (
              <div className="mt-3 space-y-4">
                {selBlock.rect ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <RectStepper
                        label="Column"
                        value={selBlock.rect.col + 1}
                        min={1}
                        max={grid.cols - selBlock.rect.colSpan + 1}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, col: v - 1 } })}
                      />
                      <RectStepper
                        label="Row"
                        value={selBlock.rect.row + 1}
                        min={1}
                        max={grid.rows - selBlock.rect.rowSpan + 1}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, row: v - 1 } })}
                      />
                      <RectStepper
                        label="Width (cols)"
                        value={selBlock.rect.colSpan}
                        min={1}
                        max={grid.cols - selBlock.rect.col}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, colSpan: v } })}
                      />
                      <RectStepper
                        label="Height (rows)"
                        value={selBlock.rect.rowSpan}
                        min={1}
                        max={grid.rows - selBlock.rect.row}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, rowSpan: v } })}
                      />
                    </div>
                    <div className="font-mono text-[11px] text-zinc-400">
                      ≈ {((page.widthMm * selBlock.rect.colSpan) / grid.cols).toFixed(1)} ×{" "}
                      {((page.heightMm * selBlock.rect.rowSpan) / grid.rows).toFixed(1)} mm
                    </div>
                    <div className="flex items-center gap-3">
                      <div>
                        <label className="text-xs text-zinc-500">Align</label>
                        <div className="mt-1 flex overflow-hidden rounded-md border border-zinc-200">
                          {(["left", "center", "right"] as const).map((a) => (
                            <button
                              key={a}
                              type="button"
                              onClick={() => updateBlock(blockId(selBlock), { align: a })}
                              className={`px-2 py-1 text-[11px] font-medium capitalize ${
                                (selBlock.align ?? "left") === a
                                  ? "bg-zinc-900 text-white"
                                  : "bg-white text-zinc-500 hover:bg-zinc-50"
                              }`}
                            >
                              {a}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500">Vertical</label>
                        <div className="mt-1 flex overflow-hidden rounded-md border border-zinc-200">
                          {(["top", "middle", "bottom"] as const).map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => updateBlock(blockId(selBlock), { valign: v })}
                              className={`px-2 py-1 text-[11px] font-medium capitalize ${
                                (selBlock.valign ?? "top") === v
                                  ? "bg-zinc-900 text-white"
                                  : "bg-white text-zinc-500 hover:bg-zinc-50"
                              }`}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-zinc-500">Font size</label>
                    <NumberStepper
                      value={selBlock.fontPt}
                      min={1}
                      max={144}
                      step={0.5}
                      suffix="pt"
                      onChange={(v) => updateBlock(blockId(selBlock), { fontPt: v })}
                    />
                  </div>
                  <p className="mt-0.5 text-[10px] text-zinc-400">Barcodes and wash symbols scale with the font size.</p>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    <input
                      type="checkbox"
                      checked={selBlock.bold}
                      onChange={(e) => updateBlock(blockId(selBlock), { bold: e.target.checked })}
                      className="accent-zinc-900"
                    />
                    Bold
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    Line height
                    <select
                      value={selBlock.lineHeight}
                      onChange={(e) => updateBlock(blockId(selBlock), { lineHeight: Number(e.target.value) })}
                      className="rounded border border-zinc-200 px-1 py-0.5 text-xs"
                    >
                      {[1.2, 1.3, 1.4, 1.5, 1.6, 1.8].map((lh) => (
                        <option key={lh} value={lh}>
                          {lh}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    Border
                    <select
                      value={selBlock.border?.widthMm ?? 0}
                      onChange={(e) => {
                        const w = Number(e.target.value);
                        updateBlock(blockId(selBlock), {
                          border:
                            w > 0
                              ? {
                                  widthMm: w,
                                  color: selBlock.border?.color ?? "#000000",
                                  // Keep existing padding; a brand-new border
                                  // starts at 0.5 mm (linked) so it's never
                                  // flush against the text.
                                  pad: selBlock.border
                                    ? effectiveBorderPad(selBlock.border)
                                    : { topMm: 0.5, rightMm: 0.5, bottomMm: 0.5, leftMm: 0.5 },
                                }
                              : undefined,
                        });
                      }}
                      className="rounded border border-zinc-200 px-1 py-0.5 text-xs"
                    >
                      <option value={0}>None</option>
                      {[0.2, 0.3, 0.5, 0.75, 1, 1.5, 2].map((w) => (
                        <option key={w} value={w}>
                          {w} mm
                        </option>
                      ))}
                    </select>
                  </label>
                  {selBlock.border ? (
                    <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                      <input
                        type="color"
                        value={selBlock.border.color}
                        onChange={(e) =>
                          updateBlock(blockId(selBlock), {
                            border: { ...selBlock.border!, color: e.target.value },
                          })
                        }
                        className="h-6 w-8 cursor-pointer rounded border border-zinc-200 bg-white p-0.5"
                        title="Border colour"
                      />
                      <input
                        type="text"
                        value={selBlock.border.color}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
                            updateBlock(blockId(selBlock), { border: { ...selBlock.border!, color: v } });
                          }
                        }}
                        className="w-20 rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[11px]"
                        spellCheck={false}
                      />
                    </label>
                  ) : null}
                </div>
                {selBlock.border ? (
                  <div className="text-xs text-zinc-600">
                    <div className="flex items-center justify-between">
                      <span>Padding mm</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (padLinked) {
                            setPadLinked(false);
                          } else {
                            const v = effectiveBorderPad(selBlock.border).topMm;
                            updateBlock(blockId(selBlock), {
                              border: {
                                ...selBlock.border!,
                                pad: { topMm: v, rightMm: v, bottomMm: v, leftMm: v },
                                padMm: undefined,
                              },
                            });
                            setPadLinked(true);
                          }
                        }}
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                          padLinked
                            ? "border-zinc-900 bg-zinc-900 text-white"
                            : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                        }`}
                        title={
                          padLinked
                            ? "Linked — one value for all sides. Click to edit each side."
                            : "Per side. Click to link all sides."
                        }
                      >
                        {padLinked ? "🔗 linked" : "per side"}
                      </button>
                    </div>
                    {padLinked ? (
                      <input
                        type="number"
                        min={0}
                        max={20}
                        step={0.5}
                        value={effectiveBorderPad(selBlock.border).topMm}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0 && v <= 20)
                            updateBlock(blockId(selBlock), {
                              border: {
                                ...selBlock.border!,
                                pad: { topMm: v, rightMm: v, bottomMm: v, leftMm: v },
                                padMm: undefined,
                              },
                            });
                        }}
                        className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm tabular-nums"
                        title="Inner padding between the border and the text"
                      />
                    ) : (
                      <div className="mt-1 grid grid-cols-2 gap-1.5">
                        {(
                          [
                            ["topMm", "Top"],
                            ["rightMm", "Right"],
                            ["bottomMm", "Bottom"],
                            ["leftMm", "Left"],
                          ] as const
                        ).map(([k, label]) => (
                          <div key={k}>
                            <label className="text-[10px] text-zinc-400">{label}</label>
                            <input
                              type="number"
                              min={0}
                              max={20}
                              step={0.5}
                              value={effectiveBorderPad(selBlock.border)[k]}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                if (Number.isFinite(v) && v >= 0 && v <= 20)
                                  updateBlock(blockId(selBlock), {
                                    border: {
                                      ...selBlock.border!,
                                      pad: { ...effectiveBorderPad(selBlock.border), [k]: v },
                                      padMm: undefined,
                                    },
                                  });
                              }}
                              className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm tabular-nums"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
                <label className="flex items-center gap-2 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    checked={selBlock.invert ?? false}
                    onChange={(e) => updateBlock(blockId(selBlock), { invert: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                  />
                  Invert block (white text on black)
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    checked={selBlock.fitWidth ?? false}
                    onChange={(e) => updateBlock(blockId(selBlock), { fitWidth: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                  />
                  Fit width (one line, auto-scale to fill)
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    checked={selBlock.fitHeight ?? false}
                    onChange={(e) => updateBlock(blockId(selBlock), { fitHeight: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                  />
                  Shrink text to fit cell (no overflow onto other blocks)
                </label>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-zinc-500">Content — one line per printed row</label>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => wrapSelection("**")}
                        className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] font-bold text-zinc-600 hover:bg-zinc-50"
                        title="Bold — wraps the selection in ** **"
                      >
                        B
                      </button>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => wrapSelection("_")}
                        className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] italic text-zinc-600 hover:bg-zinc-50"
                        title="Italic — wraps the selection in _ _"
                      >
                        I
                      </button>
                    </div>
                  </div>
                  <TokenAutocomplete
                    ref={contentTaRef}
                    value={selBlock.lines.join("\n")}
                    onValueChange={(v) => updateBlock(blockId(selBlock), { lines: v.split("\n").slice(0, 100) })}
                    suggestions={tokenSuggestions}
                    rows={6}
                    spellCheck={false}
                    className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-2 font-mono text-xs leading-relaxed"
                  />
                  <p className="mt-0.5 text-[10px] text-zinc-400">
                    Type <code className="rounded bg-zinc-100 px-1">{"{{"}</code> for variable autofill · **bold** and
                    _italic_ render in the print; the preview below shows the result.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <div className="flex items-baseline justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Variables</div>
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-500" title="Resolve every variable against the selected test style">
                <input
                  type="checkbox"
                  checked={showValues}
                  onChange={(e) => setShowValues(e.target.checked)}
                  className="accent-zinc-900"
                />
                Show values
              </label>
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">
              {selBlock ? "Click to insert at the cursor." : "Select a block first."}
              {showValues && testStyle ? ` Values from ${testStyle.name}.` : ""}
            </p>
            {(["Style", "Order & carton"] as const).map((group) => (
              <div key={group} className="mt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">{group}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {LAYOUT_TOKENS.filter((t) => t.group === group).flatMap((t) => {
                    // A multi-number carton qty offers bare + :solid/:assort
                    // (the split) + :inner/:outer (the pack pair) chips, a
                    // size-scoped field bare + :size; every other token is a
                    // single bare chip.
                    const args =
                      t.arg === "cartonKind"
                        ? ["", ...CARTON_QTY_KINDS]
                        : t.arg === "sizeScope"
                          ? ["", SIZE_SCOPE_ARG]
                          : [""];
                    return args.map((a) => {
                      const key = a ? `${t.key}:${a}` : t.key;
                      return (
                        <TokenChip
                          key={key}
                          token={`{{${key}}}`}
                          title={`${t.label}${a ? ` (${a})` : ""}${t.example ? ` — e.g. ${t.example}` : ""}`}
                          disabled={!selBlock}
                          value={showValues ? (tokenValues[key] ?? "") : undefined}
                          onClick={() => insertToken(`{{${key}}}`)}
                        />
                      );
                    });
                  })}
                </div>
              </div>
            ))}
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Per language</span>
                <select
                  value={langSel}
                  onChange={(e) => setLangSel(e.target.value)}
                  className="rounded border border-zinc-200 px-1 py-0.5 text-[11px] text-zinc-600"
                >
                  {languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.code}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {LAYOUT_TOKENS.filter((t) => t.arg === "lang").map((t) => (
                  <TokenChip
                    key={t.key}
                    token={`{{${t.key}:${langSel}}}`}
                    title={t.label}
                    disabled={!selBlock}
                    value={showValues ? (tokenValues[`${t.key}:${langSel}`] ?? "") : undefined}
                    onClick={() => insertToken(`{{${t.key}:${langSel}}}`)}
                  />
                ))}
              </div>
            </div>
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                  Sibling styles
                </span>
                <select
                  value={siblingSlot}
                  onChange={(e) => setSiblingSlot(Number(e.target.value))}
                  className="rounded border border-zinc-200 px-1 py-0.5 text-[11px] text-zinc-600"
                  title="Which carton slot these chips fill — other styles from the same PO"
                >
                  {Array.from({ length: MAX_SIBLING_SLOTS - 1 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>
                      style{n}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                Other styles from the same PO, filled on a manual print. Turn on{" "}
                <b>Multiple styles</b> in Settings, then branch:{" "}
                <code className="rounded bg-zinc-100 px-1 text-[10px]">
                  {"{{if multipleStyles == true}}{{style2}}{{else}}{{style}}{{endif}}"}
                </code>{" "}
                (<code className="rounded bg-zinc-100 px-1 text-[10px]">==</code>, not{" "}
                <code className="rounded bg-zinc-100 px-1 text-[10px]">===</code>).
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <TokenChip
                  token="{{if multipleStyles}}…{{endif}}"
                  title="Insert the multi-style conditional skeleton"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{if multipleStyles == true}}{{else}}{{endif}}")}
                />
                <TokenChip
                  token="{{style}}"
                  title="Base style number — the single-style branch"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{style}}")}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {SIBLING_FIELDS.map((f) => {
                  const key = `style${siblingSlot}${f.suffix}`;
                  return (
                    <TokenChip
                      key={key}
                      token={`{{${key}}}`}
                      title={`Style ${siblingSlot} · ${f.label}`}
                      disabled={!selBlock}
                      onClick={() => insertToken(`{{${key}}}`)}
                    />
                  );
                })}
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Calculated</div>
              <p className="mt-1 text-[11px] text-zinc-400">
                Arithmetic over field values: <code className="rounded bg-zinc-100 px-1 text-[10px]">+ − × ÷</code>,{" "}
                <code className="rounded bg-zinc-100 px-1 text-[10px]">sum/count/min/max(field)</code> across the
                styles on the carton (base + picked siblings — an empty slot counts as 0), and{" "}
                <code className="rounded bg-zinc-100 px-1 text-[10px]">round(…, decimals)</code>.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <TokenChip
                  token="{{= sum(qtyPerCarton) }}"
                  title="Total pcs in the carton — every style's qty per carton summed (just the base style's on a standard print)"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{= sum(qtyPerCarton) }}")}
                />
                <TokenChip
                  token="{{= count(styleNumber) }}"
                  title="How many styles are on the carton"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{= count(styleNumber) }}")}
                />
                <TokenChip
                  token="{{= }}"
                  title="Empty calculation — write your own expression, e.g. {{= qtyPerCarton * 2 }}"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{= }}")}
                />
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Graphics</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <TokenChip
                  token="{{barcode:cartonEan}}"
                  title="Carton EAN as Code 128 bars + number — scales with the block font size"
                  disabled={!selBlock}
                  value={showValues ? (tokenValues["barcode:cartonEan"] ?? "") : undefined}
                  onClick={() => insertToken("{{barcode:cartonEan}}")}
                />
                <TokenChip
                  token="{{barcode:cartonEan13}}"
                  title="Same carton EAN as true EAN-13 bars (digits in the symbol). Use this instead of {{barcode:cartonEan}} when the carton must print EAN-13 — no ProdSpec setting needed."
                  disabled={!selBlock}
                  value={showValues ? (tokenValues["barcode:cartonEan13"] ?? "") : undefined}
                  onClick={() => insertToken("{{barcode:cartonEan13}}")}
                />
                <TokenChip
                  token="{{barcode:ean13}}"
                  title="First size EAN as EAN-13 bars — scales with the block font size"
                  disabled={!selBlock}
                  value={showValues ? (tokenValues["barcode:ean13"] ?? "") : undefined}
                  onClick={() => insertToken("{{barcode:ean13}}")}
                />
                <TokenChip
                  token="{{washSymbols}}"
                  title="The style's wash care symbols as a row of icons — scales with the block font size. Add a mm gap with {{washSymbols:0}} (0 = flush together)."
                  disabled={!selBlock}
                  value={showValues ? (tokenValues["washSymbols"] ?? "") : undefined}
                  onClick={() => insertToken("{{washSymbols}}")}
                />
                <TokenChip
                  token="{{logo:contrast}}"
                  title="The Contrast logo (public/logos/contrast.svg in the repo) — height scales with the block font size"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{logo:contrast}}")}
                />
                <TokenChip
                  token="{{logo:contrastAddress}}"
                  title="The Contrast logo with address (public/logos/contrast-address.svg in the repo) — height scales with the block font size"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{logo:contrastAddress}}")}
                />
                <TokenChip
                  token="{{logo:custom}}"
                  title="This layout's own uploaded logo (upload it under Settings → Custom logo when this token is used) — width set as a % of its block"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{logo:custom}}")}
                />
                <TokenChip
                  token="{{cert:oekotex}}"
                  title="OEKO-TEX certification mark — prints only on styles whose Certificates field includes OEKO-TEX (no {{if}} wrapper needed). Artwork from Settings → Certificates (placeholder until the licensed mark is uploaded); height scales with the block font size"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{cert:oekotex}}")}
                />
                <TokenChip
                  token="{{cert:fsc}}"
                  title="FSC certification mark — prints only on styles whose Certificates field includes FSC (no {{if}} wrapper needed). Artwork from Settings → Certificates (placeholder until the licensed mark is uploaded); height scales with the block font size"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{cert:fsc}}")}
                />
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Logic</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <TokenChip
                  token="{{if …}} {{else}} {{endif}}"
                  title='Conditional content — e.g. {{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}. Compares case-insensitively; also supports !=.'
                  disabled={!selBlock}
                  onClick={() => insertToken("{{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}")}
                />
                <TokenChip
                  token="{{if … includes …}}"
                  title='List condition — e.g. {{if certificates includes FSC}}FSC certified{{endif}}: true when one of the comma-separated values matches, ignoring case and punctuation (OEKO-TEX = OEKOTEX). Also supports !includes. Not a substring check. Note: the {{cert:…}} marks already self-gate on the Certificates field — this is for conditional TEXT.'
                  disabled={!selBlock}
                  onClick={() => insertToken("{{if certificates includes FSC}}FSC certified{{endif}}")}
                />
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
                One condition per line, no nesting. ==/!= compare the whole value; includes/!includes check a
                comma-separated list. The {"{{cert:…}}"} marks already print only on styles that declare the
                certificate, so no wrapper is needed for them.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Edit as JSON</div>
            <p className="mt-1 text-[11px] text-zinc-400">
              The whole layout is one JSON document — page sizes, margins, blocks, repeat and file-name settings.
            </p>
            <div className="mt-3">
              {!jsonOpen ? (
                <button type="button" onClick={openJsonPanel} className="text-xs font-medium text-zinc-500 hover:text-zinc-800">
                  Edit JSON directly →
                </button>
              ) : (
                <>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    rows={16}
                    spellCheck={false}
                    className="w-full rounded-md border border-zinc-200 px-2.5 py-2 font-mono text-[10px] leading-relaxed"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={applyJson}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Apply JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => setJsonOpen(false)}
                      className="text-xs text-zinc-400 hover:text-zinc-700"
                    >
                      Close
                    </button>
                    {jsonError ? <span className="text-[11px] text-red-600">{jsonError}</span> : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
      {/* ↑ closes the Customizer visibility wrapper */}

      {/* ===== Settings tab ===== */}
      {tab === "settings" ? (
        <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
          {/* Generation activity — "how many times it has been generated" */}
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-zinc-800">Generation activity</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Every PDF this output has produced, across all styles and runs.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([
                ["Total generated", stats.total, "text-zinc-900"],
                ["Approved", stats.approved, "text-emerald-700"],
                ["Pending review", stats.pendingReview, "text-amber-700"],
                ["Rejected", stats.rejected, "text-red-700"],
              ] as const).map(([label, value, color]) => (
                <div key={label} className="rounded-md border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</dt>
                  <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${color}`}>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-zinc-400">
              {stats.distinctStyles} style{stats.distinctStyles === 1 ? "" : "s"} ·{" "}
              {stats.lastGeneratedAt
                ? `last generated ${new Date(stats.lastGeneratedAt).toLocaleString()}`
                : "never generated yet"}
            </p>
          </section>

          {/* Auto-approve — skip review queue, keep manual send */}
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-800">Auto-approve outputs</h2>
                <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                  Skip the manual per-asset review queue — an asset from this output is
                  marked <span className="font-medium text-zinc-700">approved</span> the
                  moment it generates. Two guards stay in place: a print-unsafe document
                  (missing artwork or EAN) always falls back to manual review, and a
                  person still presses <span className="font-medium text-zinc-700">“Approve
                  all &amp; publish”</span> on the style to send it to the supplier.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoApprove}
                onClick={() => setAutoApprove((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  autoApprove ? "bg-emerald-500" : "bg-zinc-300"
                }`}
                title="Toggle auto-approve (autosaves)"
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    autoApprove ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            {autoApprove ? (
              <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                On — new generations of this output skip review. Auto-approved assets show
                a system reviewer (no person) in the activity log.
              </p>
            ) : null}
          </section>

          {/* Output mechanics (repeat / split / file name / carton numbering /
              custom logo) live in the Customizer's left rail, beside the canvas
              and grid they affect — kept there when main reworked that panel. */}
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-zinc-800">Output settings</h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-500">
              Repeat &amp; split, output file name, carton numbering and the custom
              logo are edited in the{" "}
              <button
                type="button"
                onClick={() => setTab("customizer")}
                className="font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900"
              >
                Customizer
              </button>{" "}
              tab, beside the canvas and grid they affect.
            </p>
          </section>
        </div>
      ) : null}

      {/* ===== Reviews tab ===== */}
      {tab === "reviews" ? (
        <div className="px-8 py-8">
          <h2 className="text-sm font-semibold text-zinc-800">Recent generations</h2>
          <p className="mt-1 text-xs text-zinc-500">
            The {recentAssets.length} most recent PDFs this output produced. Open the
            style&apos;s review screen to approve or reject.
          </p>
          {recentAssets.length === 0 ? (
            <div className="mt-6 rounded-lg border border-dashed border-zinc-200 px-6 py-10 text-center text-sm text-zinc-400">
              This output hasn&apos;t been generated yet. It generates for a style once it&apos;s
              added as an output on that style&apos;s Prod Spec.
            </div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Style</th>
                    <th className="px-4 py-2 font-medium">File</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Generated</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {recentAssets.map((a) => (
                    <tr key={a.id} className="hover:bg-zinc-50/60">
                      <td className="px-4 py-2">
                        <Link href={`/styles/${a.styleId}/review`} className="font-medium text-zinc-800 hover:underline">
                          {a.styleName}
                        </Link>
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-zinc-500">
                        {a.displayName ?? a.fileName}
                        {a.placeholderCount > 0 ? (
                          <span className="ml-1.5 rounded bg-amber-50 px-1 py-px text-[10px] font-medium text-amber-700">
                            {a.placeholderCount} placeholder
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            a.reviewStatus === "APPROVED"
                              ? "bg-emerald-50 text-emerald-700"
                              : a.reviewStatus === "REJECTED"
                                ? "bg-red-50 text-red-700"
                                : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {a.reviewStatus === "PENDING_REVIEW" ? "Pending" : a.reviewStatus === "APPROVED" ? "Approved" : "Rejected"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">{new Date(a.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">
                        <a
                          href={`/api/admin/job-assets/${a.id}/download`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-zinc-500 hover:text-zinc-800 hover:underline"
                        >
                          Open PDF
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

// Compact −/value/+ stepper for a (possibly fractional) number — saves the
// vertical space a slider takes. The middle field accepts a comma or dot and
// commits on blur/Enter (so a "9,5" decimal can be typed without the value
// resetting mid-keystroke); the buttons step immediately.
function NumberStepper({
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const round = (v: number) => Math.round(v * 100) / 100;
  const commit = () => {
    const v = parseMm(text);
    if (Number.isFinite(v)) onChange(clamp(v));
    else setText(String(value));
  };
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => onChange(clamp(round(value - step)))}
        className="px-2 text-zinc-500 hover:bg-zinc-50"
        aria-label="Decrease"
      >
        −
      </button>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-12 border-x border-zinc-200 px-1 py-1 text-center text-sm tabular-nums focus:outline-none"
        aria-label="Value"
      />
      <button
        type="button"
        onClick={() => onChange(clamp(round(value + step)))}
        className="px-2 text-zinc-500 hover:bg-zinc-50"
        aria-label="Increase"
      >
        +
      </button>
      {suffix ? <span className="flex items-center px-1.5 text-[10px] text-zinc-400">{suffix}</span> : null}
    </div>
  );
}

function RectStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-xs text-zinc-500">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isInteger(v) && v >= min && v <= max) onChange(v);
        }}
        className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1 text-sm tabular-nums"
      />
    </div>
  );
}

function CanvasBlock({
  block,
  page,
  scale,
  selected,
  highlighted,
  onSelect,
  onRemove,
}: {
  block: LayoutBlock;
  page: LayoutPage;
  scale: number;
  selected: boolean;
  // Hovered in the Blocks list — a blue locator ring + raised stack order so
  // it stands out from (and above) overlapping neighbours.
  highlighted: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const fontPx = Math.max(block.fontPt * PT_TO_MM * scale, 7);

  // The editor is grid-only — legacy corner blocks are converted to
  // rects by parseLayoutDef before they reach this component.
  if (!block.rect) return null;
  const r = block.rect;
  const { cols: gridCols, rows: gridRows } = pageGrid(page);
  const m = page.margins ?? { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 };
  const gw = (page.widthMm - m.leftMm - m.rightMm) * scale;
  const gh = (page.heightMm - m.topMm - m.bottomMm) * scale;
  const positionStyle: React.CSSProperties = {
    left: m.leftMm * scale + (r.col / gridCols) * gw,
    top: m.topMm * scale + (r.row / gridRows) * gh,
    width: (r.colSpan / gridCols) * gw,
    height: (r.rowSpan / gridRows) * gh,
    display: "flex",
    flexDirection: "column",
    justifyContent: block.valign === "middle" ? "center" : block.valign === "bottom" ? "flex-end" : "flex-start",
    textAlign: (block.align ?? "left") as React.CSSProperties["textAlign"],
    ...(block.border
      ? {
          border: `${Math.max(block.border.widthMm * scale, 1)}px solid ${block.border.color}`,
          padding: (() => {
            const p = effectiveBorderPad(block.border);
            return `${p.topMm * scale}px ${p.rightMm * scale}px ${p.bottomMm * scale}px ${p.leftMm * scale}px`;
          })(),
        }
      : {}),
  };

  const badgePos: React.CSSProperties = { top: -8, left: -8 };

  // Selected wins the ring; otherwise a list-hover paints a blue locator.
  // Either state raises z-index so the block isn't hidden behind neighbours.
  const ringCls = selected
    ? "z-10 ring-2 ring-zinc-900/80 ring-offset-1"
    : highlighted
      ? "z-10 ring-2 ring-sky-500 ring-offset-1"
      : "hover:ring-1 hover:ring-zinc-300";
  const bgCls = block.rect ? (highlighted && !selected ? "bg-sky-100/60" : "bg-white/40") : "";

  return (
    <div
      data-block
      onClick={onSelect}
      className={`absolute cursor-pointer rounded-sm px-1 py-0.5 ${ringCls} ${bgCls}`}
      style={positionStyle}
    >
      {selected ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute z-10 flex h-4 w-4 items-center justify-center rounded-full border border-zinc-300 bg-white text-[9px] leading-none text-zinc-500 shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-600"
          style={badgePos}
          title="Delete block (Del)"
        >
          ✕
        </button>
      ) : null}
      {block.lines.map((line, i) => (
        <div
          key={i}
          className="whitespace-pre-wrap break-words"
          style={{
            fontSize: fontPx,
            lineHeight: block.lineHeight,
            fontWeight: block.bold ? 700 : 400,
            minHeight: fontPx * block.lineHeight,
          }}
        >
          <CanvasLine line={line} />
        </div>
      ))}
    </div>
  );
}

// Literal text plain, {{tokens}} as muted mono chips, {{if}}/{{else}}/
// {{endif}} control tags as italic chips, {{= …}} calcs as sky chips
// (red when the expression doesn't validate), unknown tokens red.
const CANVAS_CHIP_RE =
  /\{\{=[^{}]*\}\}|\{\{(?:if\b[^{}]*|else|endif)\}\}|\{\{[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z0-9-]+)?\}\}/g;

function CanvasLine({ line }: { line: string }) {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(CANVAS_CHIP_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(<span key={`t${i++}`}>{line.slice(last, m.index)}</span>);
    const raw = m[0];
    const isControl = /^\{\{(if\b|else\}\}|endif\}\})/.test(raw);
    const calcMatch = /^\{\{=\s*([^{}]*?)\s*\}\}$/.exec(raw);
    let cls: string;
    if (calcMatch) {
      const ok = validateCalcExpression(calcMatch[1]).length === 0;
      cls = ok ? "border-sky-200 bg-sky-50 text-sky-700" : "border-red-200 bg-red-50 text-red-600";
    } else if (isControl) {
      cls = "border-zinc-200 bg-white italic text-zinc-400";
    } else {
      const keyMatch = /^\{\{([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
      const known = keyMatch ? tokenMeta(keyMatch[1]) !== null : false;
      cls = known ? "border-zinc-200 bg-zinc-50 text-zinc-600" : "border-red-200 bg-red-50 text-red-600";
    }
    parts.push(
      <span key={`k${i++}`} className={`rounded border px-0.5 font-mono text-[0.82em] ${cls}`}>
        {raw}
      </span>,
    );
    last = m.index + raw.length;
  }
  if (last < line.length) parts.push(<span key={`e${i}`}>{line.slice(last)}</span>);
  if (parts.length === 0) parts.push(<span key="empty">&nbsp;</span>);
  return <>{parts}</>;
}

// One-line summary of a block for the Blocks list: a coarse kind tag inferred
// from the graphics token it places (so a barcode/logo/etc. reads as such),
// its first non-empty line as the label, and how many more non-empty lines
// follow. Pure — safe to call during render.
function blockSummary(block: LayoutBlock): { kind: string | null; text: string; extra: number } {
  const lines = block.lines ?? [];
  const joined = lines.join("\n");
  let kind: string | null = null;
  if (/\{\{barcode:/.test(joined)) kind = "Barcode";
  else if (/\{\{washSymbols/.test(joined)) kind = "Wash";
  else if (/\{\{logo:/.test(joined)) kind = "Logo";
  else if (/\{\{cert:/.test(joined)) kind = "Cert";
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const text = nonEmpty[0]?.trim() || "(empty)";
  return { kind, text, extra: Math.max(0, nonEmpty.length - 1) };
}

function TokenChip({
  token,
  title,
  disabled,
  value,
  onClick,
}: {
  token: string;
  title: string;
  disabled: boolean;
  // undefined → chip only; string → value row beneath ("—" when empty).
  value?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex max-w-full flex-col items-start rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-left font-mono text-[11px] text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span>{token}</span>
      {value !== undefined ? (
        value ? (
          <span className="max-w-44 truncate font-sans text-[10px] text-emerald-700">{value}</span>
        ) : (
          <span className="font-sans text-[10px] text-amber-600">—</span>
        )
      ) : null}
    </button>
  );
}

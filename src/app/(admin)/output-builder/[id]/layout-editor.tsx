"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LAYOUT_GRID_COLS,
  LAYOUT_GRID_ROWS,
  LayoutDefSchema,
  TOKEN_RE,
  blockId,
  layoutSettings,
  type LayoutBlock,
  type LayoutDef,
  type LayoutPage,
  type LayoutRect,
  type LayoutSettings,
} from "@/lib/output-layouts/schema";
import { LAYOUT_TOKENS, tokenMeta } from "@/lib/output-layouts/token-meta";
import { PreviewFrame } from "@/components/output-preview";

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

const DOC_TYPES = ["WASHCARE", "CARE_LABEL", "STICKER", "HANGTAG", "CARTON_MARKING", "COLOUR_STICKER"] as const;

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
  customerId: string | null;
  businessAreaId: string | null;
  definition: LayoutDef;
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
}: {
  layout: LayoutProps;
  customers: Customer[];
  businessAreas: BusinessArea[];
  languages: Language[];
}) {
  const [name, setName] = useState(layout.name);
  const [docType, setDocType] = useState(layout.docType);
  const [def, setDef] = useState<LayoutDef>(layout.definition);
  const [customerId, setCustomerId] = useState<string | null>(layout.customerId);
  const [businessAreaId, setBusinessAreaId] = useState<string | null>(layout.businessAreaId);
  const [status, setStatus] = useState(layout.status);
  const [version, setVersion] = useState(layout.version);

  const [pageIdx, setPageIdx] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
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
  const [styleQuery, setStyleQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewSample, setPreviewSample] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [repeatValues, setRepeatValues] = useState<string[]>([]);
  const [resolvedFileName, setResolvedFileName] = useState<string | null>(null);
  const [showValues, setShowValues] = useState(false);
  const [tokenValues, setTokenValues] = useState<Record<string, string>>({});

  const [publishing, setPublishing] = useState(false);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [pdfBusy, setPdfBusy] = useState(false);

  const [langSel, setLangSel] = useState(languages[0]?.code ?? "en");

  const [jsonText, setJsonText] = useState("");
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const contentTaRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  const page: LayoutPage | undefined = def.pages[pageIdx];
  const selBlock = page?.blocks.find((b) => blockId(b) === sel) ?? null;
  const testStyle = styles[styleIdx] ?? null;

  // ---- definition mutators (immutably rewrite def) --------------------

  const updatePage = useCallback(
    (patch: Partial<LayoutPage>) => {
      setDef((d) => ({
        pages: d.pages.map((p, i) => (i === pageIdx ? { ...p, ...patch } : p)),
      }));
    },
    [pageIdx],
  );

  const updateBlock = useCallback(
    (id: string, patch: Partial<LayoutBlock>) => {
      setDef((d) => ({
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

  function addRectBlock(rect: LayoutRect) {
    const block: LayoutBlock = {
      id: newBlockId(),
      rect,
      cols: 6,
      align: "left",
      valign: "top",
      fontPt: 9,
      bold: false,
      lineHeight: 1.4,
      lines: ["New text"],
    };
    setDef((d) => ({
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
      pages: [
        ...d.pages,
        { id, title: `Page ${d.pages.length + 1}`, widthMm: last.widthMm, heightMm: last.heightMm, blocks: [] },
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
    setDef((d) => ({ pages: d.pages.filter((_, j) => j !== i) }));
    setPageIdx((cur) => Math.max(0, cur >= i ? cur - 1 : cur));
    setSel(null);
  }

  // ---- draw-to-place (rect blocks) -------------------------------------

  function cellFromPointer(e: { clientX: number; clientY: number }): { col: number; row: number } | null {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const col = Math.min(LAYOUT_GRID_COLS - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * LAYOUT_GRID_COLS)));
    const row = Math.min(LAYOUT_GRID_ROWS - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * LAYOUT_GRID_ROWS)));
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

  // ---- autosave --------------------------------------------------------

  const payload = useMemo(
    () => JSON.stringify({ name, docType, definition: def, customerId, businessAreaId }),
    [name, docType, def, customerId, businessAreaId],
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

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (!customerId || !businessAreaId) {
        if (!cancelled) {
          setStyles([]);
          setStylesLoading(false);
        }
        return;
      }
      if (!cancelled) setStylesLoading(true);
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
        setStyles(body.styles);
        setStyleIdx(0);
      } finally {
        if (!cancelled) setStylesLoading(false);
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
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/output-layouts/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            definition: def,
            styleId: testStyle?.id,
            pageIndex: pageIdx,
            includeTokenValues: showValues,
            valuesLang: langSel,
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
  }, [JSON.stringify(def), testStyle?.id, pageIdx, showValues, langSel]);

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
        body: JSON.stringify({ definition: def, styleId: testStyle?.id, format: "pdf" }),
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

  async function applyAi() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await fetch("/api/admin/output-layouts/ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: def, prompt: aiPrompt.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { definition?: LayoutDef; error?: string };
      if (!res.ok || !body.definition) {
        setAiError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setDef(body.definition);
      setSel(null);
      setAiPrompt("");
    } finally {
      setAiBusy(false);
    }
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
    updateBlock(blockId(selBlock), { lines: next.split("\n").slice(0, 30) });
    window.setTimeout(() => {
      const el = contentTaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    }, 0);
  }

  // ---- canvas geometry ---------------------------------------------------

  const scale = useMemo(() => {
    if (!page) return 3;
    const s = Math.min(560 / page.widthMm, 380 / page.heightMm);
    return Math.min(Math.max(s, 1), 6);
  }, [page]);

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
            {DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
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
                <option value="ean">Per size / EAN</option>
              </select>
              {settings.repeatBy === "ean" ? (
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
                ) : (
                  "Text variables allowed · empty = default name"
                )}
              </p>
            </div>
          </div>
        </div>

        {/* ----- center: canvas + preview ----- */}
        <div className="min-w-0">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Canvas</div>
            <div className="font-mono text-[11px] text-zinc-400">
              {page.widthMm} × {page.heightMm} mm · {orientation} · grid {LAYOUT_GRID_COLS} × {LAYOUT_GRID_ROWS}
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
                backgroundImage:
                  "repeating-linear-gradient(to right, transparent 0, transparent calc(8.3333% - 1px), rgba(24,24,27,0.045) calc(8.3333% - 1px), rgba(24,24,27,0.045) 8.3333%)," +
                  "repeating-linear-gradient(to bottom, transparent 0, transparent calc(8.3333% - 1px), rgba(24,24,27,0.045) calc(8.3333% - 1px), rgba(24,24,27,0.045) 8.3333%)",
              }}
            >
              {page.blocks.map((block) => (
                <CanvasBlock
                  key={blockId(block)}
                  block={block}
                  page={page}
                  scale={scale}
                  selected={sel === blockId(block)}
                  onSelect={() => setSel(blockId(block))}
                  onRemove={() => removeBlock(blockId(block))}
                />
              ))}
              {ghost ? (
                <div
                  className="pointer-events-none absolute rounded-sm border border-zinc-900/50 bg-zinc-900/5"
                  style={{
                    left: `${(ghost.col / LAYOUT_GRID_COLS) * 100}%`,
                    top: `${(ghost.row / LAYOUT_GRID_ROWS) * 100}%`,
                    width: `${(ghost.colSpan / LAYOUT_GRID_COLS) * 100}%`,
                    height: `${(ghost.rowSpan / LAYOUT_GRID_ROWS) * 100}%`,
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

        {/* ----- right: inspector + variables ----- */}
        <div className="space-y-5">
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
                        max={LAYOUT_GRID_COLS - selBlock.rect.colSpan + 1}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, col: v - 1 } })}
                      />
                      <RectStepper
                        label="Row"
                        value={selBlock.rect.row + 1}
                        min={1}
                        max={LAYOUT_GRID_ROWS - selBlock.rect.rowSpan + 1}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, row: v - 1 } })}
                      />
                      <RectStepper
                        label="Width (cols)"
                        value={selBlock.rect.colSpan}
                        min={1}
                        max={LAYOUT_GRID_COLS - selBlock.rect.col}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, colSpan: v } })}
                      />
                      <RectStepper
                        label="Height (rows)"
                        value={selBlock.rect.rowSpan}
                        min={1}
                        max={LAYOUT_GRID_ROWS - selBlock.rect.row}
                        onChange={(v) => updateBlock(blockId(selBlock), { rect: { ...selBlock.rect!, rowSpan: v } })}
                      />
                    </div>
                    <div className="font-mono text-[11px] text-zinc-400">
                      ≈ {((page.widthMm * selBlock.rect.colSpan) / LAYOUT_GRID_COLS).toFixed(1)} ×{" "}
                      {((page.heightMm * selBlock.rect.rowSpan) / LAYOUT_GRID_ROWS).toFixed(1)} mm
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
                  <div className="flex items-baseline justify-between">
                    <label className="text-xs text-zinc-500">Font size</label>
                    <span className="font-mono text-[11px] text-zinc-400">{selBlock.fontPt} pt</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={24}
                    step={0.5}
                    value={selBlock.fontPt}
                    onChange={(e) => updateBlock(blockId(selBlock), { fontPt: Number(e.target.value) })}
                    className="mt-1 w-full accent-zinc-900"
                  />
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

                <div>
                  <label className="text-xs text-zinc-500">Content — one line per printed row</label>
                  <textarea
                    ref={contentTaRef}
                    value={selBlock.lines.join("\n")}
                    onChange={(e) => updateBlock(blockId(selBlock), { lines: e.target.value.split("\n").slice(0, 30) })}
                    rows={6}
                    spellCheck={false}
                    className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-2 font-mono text-xs leading-relaxed"
                  />
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
                  {LAYOUT_TOKENS.filter((t) => t.group === group).map((t) => (
                    <TokenChip
                      key={t.key}
                      token={`{{${t.key}}}`}
                      title={`${t.label}${t.example ? ` — e.g. ${t.example}` : ""}`}
                      disabled={!selBlock}
                      value={showValues ? (tokenValues[t.key] ?? "") : undefined}
                      onClick={() => insertToken(`{{${t.key}}}`)}
                    />
                  ))}
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
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Barcodes & symbols</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <TokenChip
                  token="{{barcode:cartonEan}}"
                  title="Carton EAN as Code 128 bars + number — scales with the block font size"
                  disabled={!selBlock}
                  value={showValues ? (tokenValues["barcode:cartonEan"] ?? "") : undefined}
                  onClick={() => insertToken("{{barcode:cartonEan}}")}
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
                  title="The style's wash care symbols as a row of icons — scales with the block font size"
                  disabled={!selBlock}
                  value={showValues ? (tokenValues["washSymbols"] ?? "") : undefined}
                  onClick={() => insertToken("{{washSymbols}}")}
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
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
                One condition per line, no nesting. Example: show the customer&apos;s order number on FOB orders,
                the Contrast PO otherwise.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Edit as JSON / AI</div>
            <p className="mt-1 text-[11px] text-zinc-400">
              The whole layout is one JSON document — edit it directly, or describe a change and let AI apply it.
            </p>

            <div className="mt-3">
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                rows={2}
                placeholder="e.g. Center the title, make it 14pt, and add {{barcode:ean13}} bottom right"
                className="w-full rounded-md border border-zinc-200 px-2.5 py-2 text-xs leading-relaxed"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={applyAi}
                  disabled={aiBusy || !aiPrompt.trim()}
                  className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {aiBusy ? "Applying…" : "Apply with AI"}
                </button>
                {aiError ? <span className="text-[11px] text-amber-700">{aiError}</span> : null}
              </div>
            </div>

            <div className="mt-3 border-t border-zinc-100 pt-3">
              {!jsonOpen ? (
                <button type="button" onClick={openJsonPanel} className="text-xs font-medium text-zinc-500 hover:text-zinc-800">
                  Edit JSON directly →
                </button>
              ) : (
                <>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    rows={14}
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
  );
}

// ---------------------------------------------------------------------------

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
  onSelect,
  onRemove,
}: {
  block: LayoutBlock;
  page: LayoutPage;
  scale: number;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const fontPx = Math.max(block.fontPt * PT_TO_MM * scale, 7);
  void page;
  void scale;

  // The editor is grid-only — legacy corner blocks are converted to
  // rects by parseLayoutDef before they reach this component.
  if (!block.rect) return null;
  const r = block.rect;
  const positionStyle: React.CSSProperties = {
    left: `${(r.col / LAYOUT_GRID_COLS) * 100}%`,
    top: `${(r.row / LAYOUT_GRID_ROWS) * 100}%`,
    width: `${(r.colSpan / LAYOUT_GRID_COLS) * 100}%`,
    height: `${(r.rowSpan / LAYOUT_GRID_ROWS) * 100}%`,
    display: "flex",
    flexDirection: "column",
    justifyContent: block.valign === "middle" ? "center" : block.valign === "bottom" ? "flex-end" : "flex-start",
    textAlign: (block.align ?? "left") as React.CSSProperties["textAlign"],
  };

  const badgePos: React.CSSProperties = { top: -8, left: -8 };

  return (
    <div
      data-block
      onClick={onSelect}
      className={`absolute cursor-pointer rounded-sm px-1 py-0.5 ${
        selected ? "ring-2 ring-zinc-900/80 ring-offset-1" : "hover:ring-1 hover:ring-zinc-300"
      } ${block.rect ? "bg-white/40" : ""}`}
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
// {{endif}} control tags as italic chips, unknown tokens red.
const CANVAS_CHIP_RE =
  /\{\{(?:if\b[^{}]*|else|endif)\}\}|\{\{[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z0-9-]+)?\}\}/g;

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
    let cls: string;
    if (isControl) {
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

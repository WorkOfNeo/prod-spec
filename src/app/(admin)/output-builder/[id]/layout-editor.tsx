"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LAYOUT_GRID_COLS,
  TOKEN_RE,
  type LayoutAnchor,
  type LayoutBlock,
  type LayoutDef,
  type LayoutPage,
} from "@/lib/output-layouts/schema";
import { LAYOUT_TOKENS, tokenMeta } from "@/lib/output-layouts/token-meta";
import { PreviewFrame } from "@/components/output-preview";

// =====================================================
// Output Builder editor — one layout, three panes:
//   left   pages (title + mm dims + orientation)
//   center canvas (true aspect, 12-col grid, corner blocks) + true-render preview
//   right  block inspector + variables palette
// Test data: pick customer × business area, cycle through that pair's
// styles ranked fullest-first; the preview below the canvas always shows
// the REAL renderer's output for the selected style.
// =====================================================

const AUTOSAVE_MS = 1200;
const PREVIEW_DEBOUNCE_MS = 600;
const PT_TO_MM = 25.4 / 72;

const DOC_TYPES = ["WASHCARE", "CARE_LABEL", "STICKER", "HANGTAG", "CARTON_MARKING", "COLOUR_STICKER"] as const;

const ANCHORS: Array<{ key: LayoutAnchor; label: string }> = [
  { key: "top-left", label: "Top left" },
  { key: "top-right", label: "Top right" },
  { key: "bottom-left", label: "Bottom left" },
  { key: "bottom-right", label: "Bottom right" },
];

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
  const [sel, setSel] = useState<LayoutAnchor | null>(null);

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

  const [publishing, setPublishing] = useState(false);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [pdfBusy, setPdfBusy] = useState(false);

  const [langSel, setLangSel] = useState(languages[0]?.code ?? "en");

  const contentTaRef = useRef<HTMLTextAreaElement>(null);
  const firstRender = useRef(true);

  const page: LayoutPage | undefined = def.pages[pageIdx];
  const selBlock = page?.blocks.find((b) => b.anchor === sel) ?? null;
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
    (anchor: LayoutAnchor, patch: Partial<LayoutBlock>) => {
      setDef((d) => ({
        pages: d.pages.map((p, i) =>
          i === pageIdx
            ? { ...p, blocks: p.blocks.map((b) => (b.anchor === anchor ? { ...b, ...patch } : b)) }
            : p,
        ),
      }));
    },
    [pageIdx],
  );

  function addBlock(anchor: LayoutAnchor) {
    if (!page || page.blocks.some((b) => b.anchor === anchor)) return;
    const block: LayoutBlock = {
      anchor,
      cols: 6,
      fontPt: 9,
      bold: false,
      lineHeight: 1.4,
      lines: ["New text"],
    };
    setDef((d) => ({
      pages: d.pages.map((p, i) => (i === pageIdx ? { ...p, blocks: [...p.blocks, block] } : p)),
    }));
    setSel(anchor);
  }

  function removeBlock(anchor: LayoutAnchor) {
    setDef((d) => ({
      pages: d.pages.map((p, i) =>
        i === pageIdx ? { ...p, blocks: p.blocks.filter((b) => b.anchor !== anchor) } : p,
      ),
    }));
    setSel(null);
  }

  // Move the selected block to another corner; if occupied, swap.
  function moveBlock(from: LayoutAnchor, to: LayoutAnchor) {
    if (from === to) return;
    setDef((d) => ({
      pages: d.pages.map((p, i) => {
        if (i !== pageIdx) return p;
        return {
          ...p,
          blocks: p.blocks.map((b) =>
            b.anchor === from ? { ...b, anchor: to } : b.anchor === to ? { ...b, anchor: from } : b,
          ),
        };
      }),
    }));
    setSel(to);
  }

  function addPage() {
    const last = def.pages[def.pages.length - 1];
    const id = `p${Date.now().toString(36)}`;
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
          }),
        });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { html: string; unresolved: string[]; usingSampleData: boolean };
        if (cancelled) return;
        setPreviewHtml(body.html);
        setUnresolved(body.unresolved);
        setPreviewSample(body.usingSampleData);
      } catch {
        // network hiccup — keep the last good preview
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(def), testStyle?.id, pageIdx]);

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
    updateBlock(selBlock.anchor, { lines: next.split("\n").slice(0, 30) });
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
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setPageIdx(i);
                  setSel(null);
                }}
                className={`rounded-md border px-3 py-2 text-left ${
                  i === pageIdx ? "border-zinc-900 bg-white" : "border-zinc-200 bg-white hover:border-zinc-300"
                }`}
              >
                <div className="text-sm font-medium text-zinc-800">
                  {i + 1} · {p.title || "Untitled"}
                </div>
                <div className="font-mono text-[11px] text-zinc-400">
                  {p.widthMm} × {p.heightMm} mm
                </div>
              </button>
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
        </div>

        {/* ----- center: canvas + preview ----- */}
        <div className="min-w-0">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Canvas</div>
            <div className="font-mono text-[11px] text-zinc-400">
              {page.widthMm} × {page.heightMm} mm · {orientation} · grid {LAYOUT_GRID_COLS} × {LAYOUT_GRID_COLS}
            </div>
          </div>
          <div className="mt-2 flex justify-center rounded-lg border border-zinc-200 bg-zinc-50/60 px-6 py-10">
            <div
              className="relative border border-zinc-300 bg-white shadow-sm"
              style={{
                width: page.widthMm * scale,
                height: page.heightMm * scale,
                backgroundImage:
                  "repeating-linear-gradient(to right, transparent 0, transparent calc(8.3333% - 1px), rgba(24,24,27,0.045) calc(8.3333% - 1px), rgba(24,24,27,0.045) 8.3333%)," +
                  "repeating-linear-gradient(to bottom, transparent 0, transparent calc(8.3333% - 1px), rgba(24,24,27,0.045) calc(8.3333% - 1px), rgba(24,24,27,0.045) 8.3333%)",
              }}
            >
              {ANCHORS.map(({ key }) => {
                const block = page.blocks.find((b) => b.anchor === key);
                if (!block) {
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => addBlock(key)}
                      className={`absolute flex items-center justify-center rounded border border-dashed border-zinc-200 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-400 hover:text-zinc-500 ${zoneClass(key)}`}
                      style={{ width: "42%", height: "40%" }}
                      title={`Add a text block ${key.replace("-", " ")}`}
                    >
                      + text
                    </button>
                  );
                }
                return (
                  <CanvasBlock
                    key={key}
                    block={block}
                    page={page}
                    scale={scale}
                    selected={sel === key}
                    onSelect={() => setSel(key)}
                  />
                );
              })}
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-zinc-400">
            Click a corner to add a block · click a block to edit · blocks grow from their corner inward
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
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Block{selBlock ? ` — ${selBlock.anchor.replace("-", " ")}` : ""}
            </div>
            {!selBlock ? (
              <p className="mt-2 text-xs text-zinc-400">Select a block on the canvas, or click an empty corner to add one.</p>
            ) : (
              <div className="mt-3 space-y-4">
                <div className="grid grid-cols-2 gap-1.5">
                  {ANCHORS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => moveBlock(selBlock.anchor, key)}
                      className={`rounded-md border px-2 py-1.5 text-[11px] font-medium ${
                        selBlock.anchor === key
                          ? "border-zinc-900 bg-zinc-900 text-white"
                          : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div>
                  <div className="flex items-baseline justify-between">
                    <label className="text-xs text-zinc-500">Width</label>
                    <span className="font-mono text-[11px] text-zinc-400">
                      {selBlock.cols} cols ≈ {((page.widthMm * selBlock.cols) / LAYOUT_GRID_COLS).toFixed(1)} mm
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={LAYOUT_GRID_COLS}
                    value={selBlock.cols}
                    onChange={(e) => updateBlock(selBlock.anchor, { cols: Number(e.target.value) })}
                    className="mt-1 w-full accent-zinc-900"
                  />
                </div>

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
                    onChange={(e) => updateBlock(selBlock.anchor, { fontPt: Number(e.target.value) })}
                    className="mt-1 w-full accent-zinc-900"
                  />
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    <input
                      type="checkbox"
                      checked={selBlock.bold}
                      onChange={(e) => updateBlock(selBlock.anchor, { bold: e.target.checked })}
                      className="accent-zinc-900"
                    />
                    Bold
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    Line height
                    <select
                      value={selBlock.lineHeight}
                      onChange={(e) => updateBlock(selBlock.anchor, { lineHeight: Number(e.target.value) })}
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
                    onChange={(e) => updateBlock(selBlock.anchor, { lines: e.target.value.split("\n").slice(0, 30) })}
                    rows={6}
                    spellCheck={false}
                    className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-2 font-mono text-xs leading-relaxed"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => removeBlock(selBlock.anchor)}
                  className="text-xs text-zinc-400 hover:text-red-600"
                >
                  Remove block
                </button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Variables</div>
            <p className="mt-1 text-[11px] text-zinc-400">
              {selBlock ? "Click to insert at the cursor." : "Select a block first."}
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
                    onClick={() => insertToken(`{{${t.key}:${langSel}}}`)}
                  />
                ))}
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Barcodes</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <TokenChip
                  token="{{barcode:cartonEan}}"
                  title="Carton EAN as Code 128 bars + number"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{barcode:cartonEan}}")}
                />
                <TokenChip
                  token="{{barcode:ean13}}"
                  title="First size EAN as EAN-13 bars"
                  disabled={!selBlock}
                  onClick={() => insertToken("{{barcode:ean13}}")}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function zoneClass(anchor: LayoutAnchor): string {
  switch (anchor) {
    case "top-left":
      return "left-[2%] top-[3%]";
    case "top-right":
      return "right-[2%] top-[3%]";
    case "bottom-left":
      return "bottom-[3%] left-[2%]";
    case "bottom-right":
      return "bottom-[3%] right-[2%]";
  }
}

function blockPosition(anchor: LayoutAnchor): React.CSSProperties {
  switch (anchor) {
    case "top-left":
      return { top: "2%", left: "1.5%", textAlign: "left" };
    case "top-right":
      return { top: "2%", right: "1.5%", textAlign: "right" };
    case "bottom-left":
      return { bottom: "2%", left: "1.5%", textAlign: "left" };
    case "bottom-right":
      return { bottom: "2%", right: "1.5%", textAlign: "right" };
  }
}

function CanvasBlock({
  block,
  page,
  scale,
  selected,
  onSelect,
}: {
  block: LayoutBlock;
  page: LayoutPage;
  scale: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const fontPx = Math.max(block.fontPt * PT_TO_MM * scale, 7);
  const widthPx = ((page.widthMm * block.cols) / LAYOUT_GRID_COLS) * scale;
  return (
    <div
      onClick={onSelect}
      className={`absolute cursor-pointer rounded-sm px-1 py-0.5 ${
        selected ? "ring-2 ring-zinc-900/80 ring-offset-1" : "hover:ring-1 hover:ring-zinc-300"
      }`}
      style={{ ...blockPosition(block.anchor), width: widthPx, maxWidth: "96%" }}
    >
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

// Literal text plain, {{tokens}} as muted mono chips, unknown tokens red.
function CanvasLine({ line }: { line: string }) {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(<span key={`t${i++}`}>{line.slice(last, m.index)}</span>);
    const known = tokenMeta(m[1]) !== null;
    parts.push(
      <span
        key={`k${i++}`}
        className={`rounded border px-0.5 font-mono text-[0.82em] ${
          known ? "border-zinc-200 bg-zinc-50 text-zinc-600" : "border-red-200 bg-red-50 text-red-600"
        }`}
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(<span key={`e${i}`}>{line.slice(last)}</span>);
  if (parts.length === 0) parts.push(<span key="empty">&nbsp;</span>);
  return <>{parts}</>;
}

function TokenChip({
  token,
  title,
  disabled,
  onClick,
}: {
  token: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {token}
    </button>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { PreviewFrame } from "@/components/output-preview";
import type { ImpactSummary } from "@/lib/change-requests/types";
import { REVIEW_STATUS_LABEL, documentUrl, walkthroughStyles } from "./shared";
import { useCachedFetch, type Load } from "./use-cached-fetch";

// The draft walkthrough (ADMIN): the whole draft, every page, on any style the
// change touches, next to what prints today — so a person can step through it
// style by style before approving, not only the first page of the picked
// proofs. Opens over the review screen and closes back to it; read-only.
//
// Styles come from the draft's impact list (the request's own style first,
// then the changed ones); ← / → step through them, Esc closes. Each document
// is fetched once (…/revisions/[id]/document) and kept for the visit, so
// stepping back is instant.

type DocumentResponse = {
  html: string;
  widthMm: number;
  heightMm: number;
  suffix: string | null;
  doc: number;
  documents: { suffix: string | null }[];
};

// "Fit" fills the pane, enlarging a small label up to this factor.
const FIT_MAX_SCALE = 8;

export function DraftWalkthrough({
  revisionId,
  title,
  impact,
  focusStyleId,
  onClose,
}: {
  revisionId: string;
  title: string;
  impact: ImpactSummary;
  focusStyleId: string | null;
  onClose: () => void;
}) {
  const all = useMemo(() => walkthroughStyles(impact.rows, focusStyleId), [impact.rows, focusStyleId]);
  const anyChanged = all.some((s) => s.changed);
  const [onlyChanged, setOnlyChanged] = useState(anyChanged);
  const styles = onlyChanged ? all.filter((s) => s.changed || s.styleId === focusStyleId) : all;

  const [styleId, setStyleId] = useState<string | null>(styles[0]?.styleId ?? null);
  const index = Math.max(0, styles.findIndex((s) => s.styleId === styleId));
  const style = styles[index] ?? null;

  // The document picked per style; a style not visited yet opens on its first
  // (changed-first) document.
  const [docByStyle, setDocByStyle] = useState<Record<string, string | null>>({});
  const suffix = style ? (style.styleId in docByStyle ? docByStyle[style.styleId] : (style.docs[0]?.suffix ?? null)) : null;
  const docInfo = style?.docs.find((d) => d.suffix === suffix) ?? null;

  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const [panes, setPanes] = useState<"both" | "draft">("both");

  const go = (step: number) => {
    if (styles.length === 0) return;
    setStyleId(styles[(index + step + styles.length) % styles.length].styleId);
  };

  // Re-bound every render: the handler reads the current position.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The review screen behind stays put while this is open.
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const before = useCachedFetch<DocumentResponse>(
    style && panes === "both" ? documentUrl(revisionId, style.styleId, "before", suffix) : null,
  );
  const after = useCachedFetch<DocumentResponse>(style ? documentUrl(revisionId, style.styleId, "after", suffix) : null);
  const maxScale = zoom === "fit" ? FIT_MAX_SCALE : 1;

  // Into <body>: an ancestor of the review screen makes a containing block
  // for fixed elements, which would clip the overlay short of the window.
  // Opened by a click, so it never renders on the server; guarded anyway.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-zinc-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900">{title}</h2>
        <span className="text-xs text-zinc-500">Read-only: nothing here changes what prints.</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          <X className="h-4 w-4" aria-hidden />
          Close
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 text-sm">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={styles.length < 2}
          aria-label="Previous style"
          className="rounded-md border border-zinc-300 p-1 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <select
          aria-label="Style"
          value={style?.styleId ?? ""}
          onChange={(e) => setStyleId(e.target.value)}
          className="min-w-0 max-w-sm rounded-md border border-zinc-300 bg-white px-2 py-1"
        >
          {styles.map((s) => (
            <option key={s.styleId} value={s.styleId}>
              {s.styleLabel}
              {s.poNumber ? ` · ${s.poNumber}` : ""}
              {s.changed ? " · changes" : ""}
              {s.styleId === focusStyleId ? " · this request" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={styles.length < 2}
          aria-label="Next style"
          className="rounded-md border border-zinc-300 p-1 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
        <span className="font-mono text-xs tabular-nums text-zinc-500">
          {styles.length === 0 ? "0 / 0" : `${index + 1} / ${styles.length}`}
        </span>

        {style && style.docs.length > 1 && (
          <select
            aria-label="Document"
            value={suffix ?? ""}
            onChange={(e) => setDocByStyle((prev) => ({ ...prev, [style.styleId]: e.target.value || null }))}
            className="min-w-0 max-w-xs rounded-md border border-zinc-300 bg-white px-2 py-1"
          >
            {style.docs.map((d) => (
              <option key={d.suffix ?? ""} value={d.suffix ?? ""}>
                {d.suffix ?? "Document"}
                {d.changed ? " · changes" : ""}
              </option>
            ))}
          </select>
        )}

        {anyChanged && (
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(e) => {
                setOnlyChanged(e.target.checked);
                setStyleId(null);
              }}
            />
            Only styles that change
          </label>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Toggle
            label="Show"
            value={panes}
            options={[
              { value: "both", label: "Today + draft" },
              { value: "draft", label: "Draft only" },
            ]}
            onChange={setPanes}
          />
          <Toggle
            label="Zoom"
            value={zoom}
            options={[
              { value: "fit", label: "Fit" },
              { value: "actual", label: "Actual size" },
            ]}
            onChange={setZoom}
          />
        </div>
      </div>

      {style && docInfo && (
        <p className="border-b border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-600">
          {docInfo.changed ? (
            <span className="font-medium text-amber-700">This document changes with the draft.</span>
          ) : (
            <span>This document is the same as today.</span>
          )}{" "}
          Today: {REVIEW_STATUS_LABEL[docInfo.reviewStatus].toLowerCase()}.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!style ? (
          <p className="text-sm text-zinc-500">No style prints this layout, so there is nothing to walk through.</p>
        ) : (
          <div className={`grid gap-4 ${panes === "both" ? "lg:grid-cols-2" : ""}`}>
            {panes === "both" && <Pane label="Today" load={before} maxScale={maxScale} />}
            <Pane label="Draft" load={after} maxScale={maxScale} highlight />
          </div>
        )}
      </div>

      <footer className="border-t border-zinc-200 bg-white px-4 py-1.5 text-[11px] text-zinc-500">
        ← → step through styles · Esc closes
      </footer>
    </div>,
    document.body,
  );
}

function Pane({
  label,
  load,
  maxScale,
  highlight = false,
}: {
  label: string;
  load: Load<DocumentResponse> | null;
  maxScale: number;
  highlight?: boolean;
}) {
  return (
    <section className={`rounded-lg border bg-white p-3 ${highlight ? "border-amber-300" : "border-zinc-200"}`}>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</h3>
      {!load || load.state === "loading" ? (
        <p className="flex items-center gap-1.5 text-sm text-zinc-500">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          Rendering…
        </p>
      ) : load.state === "error" ? (
        <p className="flex items-center gap-1.5 text-sm text-red-600">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          {load.message}
        </p>
      ) : (
        <div className="rounded-md bg-zinc-100 p-3">
          <PreviewFrame
            html={load.data.html}
            widthMm={load.data.widthMm}
            heightMm={load.data.heightMm}
            maxScale={maxScale}
          />
          <p className="mt-2 text-[11px] text-zinc-500">
            {Math.round(load.data.widthMm)}×{Math.round(load.data.heightMm)} mm
          </p>
        </div>
      )}
    </section>
  );
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-zinc-300 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-0.5 text-xs ${
            value === o.value ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

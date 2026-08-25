"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PreviewFrame } from "@/components/output-preview";
import type { DocumentLine } from "@/lib/output-layouts/lines";
import { MAX_LINE_LENGTH } from "@/lib/output-layouts/line-keys";

// The review screen's document editor — one dialog, opened from the output
// card, laid out like the Output Builder: the editable lines down the left, a
// live render of THIS document on the right that follows what you type.
//
// It replaces the two inline <details> panels that used to sit under each card
// (fields + lines). The line editor is the superset: every text line the
// document prints is here, whether or not a field backs it — including text
// hardcoded in the layout, which no field edit can reach. What the reviewer
// types is a SOURCE line, so plain text prints verbatim and a {{token}} still
// resolves.
//
// SCOPE: an edit fixes THIS PDF by default (stored on the document's own
// "<base>#<suffix>" key). "Apply to every PDF…" stores it on the base key
// instead — for a hardcoded literal that is identical on all of them — and
// drops this document's own rewrite of those lines so the base value lands
// here too. Single-document outputs have only one key, so the choice is hidden.
//
// Saving POSTs to /api/admin/styles/[id]/output-lines, which stores the
// rewrites and re-renders the output through the runner inline. The dialog
// stays open, disabled, until that render AND the page refresh have landed —
// so it closes onto the finished PDF, never onto the old one.
export function OutputEditDialog({
  styleId,
  variantKey,
  baseKey,
  outputName,
  lines,
  isMultiDoc,
  widthMm,
  heightMm,
}: {
  styleId: string;
  // The document being viewed — base key, or "base#suffix" for one PDF.
  variantKey: string;
  baseKey: string;
  outputName: string;
  lines: DocumentLine[];
  // Does this output render more than one PDF? Drives the scope checkbox.
  isMultiDoc: boolean;
  // Printed size of this output, for the live preview's paper.
  widthMm: number;
  heightMm: number;
}) {
  const [open, setOpen] = useState(false);
  const editedCount = lines.filter((l) => l.overridden).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-[11px] font-medium text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-800"
      >
        Edit any line{editedCount > 0 ? ` (${editedCount} edited)` : ""}
      </button>
      {open ? (
        <EditDialog
          styleId={styleId}
          variantKey={variantKey}
          baseKey={baseKey}
          outputName={outputName}
          lines={lines}
          isMultiDoc={isMultiDoc}
          widthMm={widthMm}
          heightMm={heightMm}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// How long to sit on a keystroke before re-rendering the preview. Long enough
// that typing a line doesn't fire a render per character, short enough that
// pausing shows the result.
const PREVIEW_DEBOUNCE_MS = 500;

type PreviewState =
  | { kind: "loading" }
  | { kind: "html"; html: string }
  | { kind: "static"; message: string }
  | { kind: "error"; message: string };

function EditDialog({
  styleId,
  variantKey,
  baseKey,
  outputName,
  lines,
  isMultiDoc,
  widthMm,
  heightMm,
  onClose,
}: {
  styleId: string;
  variantKey: string;
  baseKey: string;
  outputName: string;
  lines: DocumentLine[];
  isMultiDoc: boolean;
  widthMm: number;
  heightMm: number;
  onClose: () => void;
}) {
  const router = useRouter();

  const [values, setValues] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const l of lines) m[l.lineKey] = l.source;
    return m;
  });
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [applyToAll, setApplyToAll] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  // Which edit state the preview on screen was rendered from — anything else
  // means it is out of date, which is `stale` below. Derived rather than a
  // second flag, so it can never disagree with what is shown.
  const [renderedFor, setRenderedFor] = useState<string | null>(null);
  // Set once the save has returned; the dialog then closes as soon as the
  // router refresh that follows it has landed.
  const [refreshing, startRefresh] = useTransition();
  const closeWhenSettled = useRef(false);

  // Only CHANGED lines are persisted, and a line typed back to the layout's own
  // text clears the override rather than freezing an identical-looking copy.
  // The preview posts the same map, so what it shows is what a save produces.
  const changes = useCallback(() => {
    const byKey = new Map(lines.map((l) => [l.lineKey, l]));
    const out: Record<string, string> = {};
    for (const key of dirty) {
      const v = values[key] ?? "";
      out[key] = v.trim() === (byKey.get(key)?.authored ?? "").trim() ? "" : v;
    }
    return out;
  }, [dirty, lines, values]);

  const hasChanges = dirty.size > 0;
  const busy = pending || refreshing;

  // Live preview — this document as it would print after a save, re-fetched a
  // beat after typing stops. The previous render stays on screen while the next
  // one loads (flagged "Updating…"), so the pane never flashes empty.
  const payload = JSON.stringify(changes());
  const stale = renderedFor !== payload;
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/styles/${styleId}/output-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantKey, lineOverrides: JSON.parse(payload) }),
          cache: "no-store",
        });
        const contentType = res.headers.get("content-type") ?? "";
        if (res.ok && contentType.includes("text/html")) {
          const html = await res.text();
          if (!cancelled) setPreview({ kind: "html", html });
        } else {
          const body = (await res.json().catch(() => ({}))) as {
            staticPdf?: boolean;
            message?: string;
            error?: string;
          };
          if (cancelled) return;
          setPreview(
            res.status === 409 && body.staticPdf
              ? { kind: "static", message: body.message ?? "Static artwork passthrough." }
              : { kind: "error", message: body.error ?? `HTTP ${res.status}` },
          );
        }
      } catch (e) {
        if (!cancelled) {
          setPreview({ kind: "error", message: e instanceof Error ? e.message : "Preview failed" });
        }
      } finally {
        if (!cancelled) setRenderedFor(payload);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [styleId, variantKey, payload]);

  // Escape cancels (never while a re-render is in flight — the job is already
  // running and the dialog is the only thing reporting on it). A click on the
  // backdrop deliberately does NOT close: typed edits are easy to lose and the
  // dialog offers exactly two ways out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // The save is done when the re-render is done (the endpoint runs the job
  // inline) AND the refreshed card data has arrived — close on that.
  useEffect(() => {
    if (closeWhenSettled.current && !refreshing) onClose();
  }, [refreshing, onClose]);

  function setVal(key: string, v: string) {
    setValues((p) => ({ ...p, [key]: v }));
    setDirty((p) => new Set(p).add(key));
  }

  async function save() {
    const payloadValues = changes();
    if (Object.keys(payloadValues).length === 0) {
      setError("No changes to save.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/output-lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantKey: applyToAll ? baseKey : variantKey,
          // Applying to every PDF also drops this document's own rewrite of
          // those lines, which would otherwise shadow the shared value here.
          clearVariantKey: applyToAll && variantKey !== baseKey ? variantKey : undefined,
          outputName,
          values: payloadValues,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (${res.status})`);
        setPending(false);
        return;
      }
      closeWhenSettled.current = true;
      startRefresh(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setPending(false);
    }
  }

  // Group by page so a multi-page layout reads like the document.
  const pages: { pageId: string; title: string; rows: DocumentLine[] }[] = [];
  for (const l of lines) {
    const last = pages[pages.length - 1];
    if (last && last.pageId === l.pageId) last.rows.push(l);
    else pages.push({ pageId: l.pageId, title: l.pageTitle, rows: [l] });
  }
  const docSuffix = variantKey.includes("#") ? variantKey.slice(variantKey.indexOf("#") + 1) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${outputName}`}
    >
      <div className="flex h-[92vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-baseline gap-2 border-b border-zinc-200 px-5 py-3">
          <h3 className="truncate text-sm font-semibold text-zinc-900">{outputName}</h3>
          {docSuffix ? (
            <span className="truncate font-mono text-[11px] text-zinc-500">· {docSuffix}</span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Left — every line this document prints. */}
          <div className="flex w-[420px] shrink-0 flex-col border-r border-zinc-200">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {lines.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  This output isn&apos;t built from an Output Builder layout, so it has no editable
                  lines. Correct it in its template, or on Monday.
                </p>
              ) : (
                <>
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Every line this document prints. Type plain text, or use a{" "}
                    <code className="rounded bg-zinc-100 px-1">{"{{token}}"}</code> — both work.
                    Clearing a line back to its original reverts it to the layout.
                  </p>
                  <div className="mt-3 space-y-3">
                    {pages.map((p) => (
                      <div key={p.pageId} className="space-y-2">
                        {pages.length > 1 ? (
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                            {p.title}
                          </p>
                        ) : null}
                        {p.rows.map((l) => {
                          const changed = (values[l.lineKey] ?? "") !== l.source;
                          const isOverride = l.overridden || changed;
                          const blank =
                            !l.authored.trim() && !(values[l.lineKey] ?? "").trim();
                          return (
                            <div key={l.lineKey}>
                              <div className="flex items-center gap-1.5">
                                {/* What this line prints right now — how a
                                    reviewer finds the line they mean. Blank
                                    layout spacers say so, so they read as "you
                                    can add text here" rather than as a bug. */}
                                <p
                                  className="min-w-0 flex-1 truncate text-[11px] text-zinc-600"
                                  title={l.resolved || (blank ? "empty line" : "(prints nothing)")}
                                >
                                  {l.resolved || (
                                    <span className="italic text-zinc-400">
                                      {blank ? "empty" : "prints nothing"}
                                    </span>
                                  )}
                                </p>
                                {isOverride ? (
                                  <span className="rounded-sm bg-amber-100 px-1 text-[9px] font-semibold uppercase text-amber-700">
                                    edited
                                  </span>
                                ) : null}
                                {l.kind === "graphic" ? (
                                  <span
                                    title="This line draws a barcode, symbol or logo — replacing it prints text instead."
                                    className="rounded-sm bg-zinc-100 px-1 text-[9px] font-semibold uppercase text-zinc-500"
                                  >
                                    graphic
                                  </span>
                                ) : null}
                              </div>
                              <input
                                type="text"
                                value={values[l.lineKey] ?? ""}
                                disabled={busy}
                                maxLength={MAX_LINE_LENGTH}
                                onChange={(e) => setVal(l.lineKey, e.target.value)}
                                placeholder="empty line — type to add text"
                                className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1 font-mono text-[11px] disabled:bg-zinc-50"
                              />
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Right — this document as it would print after saving. */}
          <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-100 p-6">
            <div className="mx-auto max-w-3xl">
              {preview.kind === "html" ? (
                <div className={stale ? "opacity-60 transition-opacity" : "transition-opacity"}>
                  <PreviewFrame html={preview.html} widthMm={widthMm} heightMm={heightMm} />
                </div>
              ) : preview.kind === "static" ? (
                <div className="rounded-md border border-dashed border-zinc-300 bg-white px-3 py-6 text-center text-xs text-zinc-500">
                  {preview.message}
                </div>
              ) : preview.kind === "error" ? (
                <div className="rounded-md border border-dashed border-red-300 bg-red-50 px-3 py-6 text-center text-xs text-red-600">
                  Preview failed to render
                  <div className="mt-1 text-red-400">{preview.message}</div>
                </div>
              ) : (
                <div className="rounded-md bg-white/60 px-3 py-10 text-center text-[11px] text-zinc-400">
                  Rendering preview…
                </div>
              )}
              <p className="mt-3 text-center text-[10px] text-zinc-400">
                {stale && preview.kind === "html"
                  ? "Updating…"
                  : "Live preview — Save & re-render to produce the PDF."}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-zinc-200 px-5 py-3">
          <div className="min-w-0 flex-1">
            {isMultiDoc ? (
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                <input
                  type="checkbox"
                  checked={applyToAll}
                  disabled={busy}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                />
                Apply to every PDF this output renders — off, it fixes only this one
              </label>
            ) : null}
            {error ? <p className="text-[11px] font-medium text-red-700">{error}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !hasChanges}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Re-rendering…" : "Save & re-render"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

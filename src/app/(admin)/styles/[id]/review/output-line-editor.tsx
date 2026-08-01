"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DocumentLine } from "@/lib/output-layouts/lines";
import { MAX_LINE_LENGTH } from "@/lib/output-layouts/line-keys";

// The catch-all line editor for ONE output of ONE style — every text line the
// document prints, editable, whether or not it is backed by a field.
//
// Sits BELOW the field editor deliberately: a field edit fixes the data and so
// fixes every output that prints it, and keeps tracking Monday. A line edit
// rewrites this document only and freezes that line. Field first, line as the
// escape hatch — which is the only way to reach text hardcoded in the layout.
//
// What the reviewer types is a SOURCE line, so plain text prints verbatim and a
// {{token}} still resolves. Saving POSTs to /api/admin/styles/[id]/output-lines,
// which stores the rewrites and re-renders the output through the runner.
//
// Scope: by default a rewrite is stored on the BASE variantKey and applies to
// every PDF of the output — a hardcoded literal is identical on all of them, so
// editing once should fix all of them. "Only this document" switches to the
// per-PDF key for the cases where the line genuinely differs.
export function OutputLineEditor({
  styleId,
  variantKey,
  baseKey,
  outputName,
  lines,
  isMultiDoc,
}: {
  styleId: string;
  // The document being viewed — base key, or "base#suffix" for one PDF.
  variantKey: string;
  baseKey: string;
  outputName: string;
  lines: DocumentLine[];
  // Does this output render more than one PDF? Drives the scope toggle.
  isMultiDoc: boolean;
}) {
  const router = useRouter();

  const sig = JSON.stringify(lines.map((l) => [l.lineKey, l.source, l.resolved]));

  const buildValues = () => {
    const m: Record<string, string> = {};
    for (const l of lines) m[l.lineKey] = l.source;
    return m;
  };

  const [values, setValues] = useState<Record<string, string>>(buildValues);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [thisDocOnly, setThisDocOnly] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the server hands down freshly-rendered lines (after
  // router.refresh()). Adjusting state DURING RENDER rather than in an effect
  // is React's own recommendation for "reset state when a prop changes" — it
  // re-renders before committing, with no cascading-render round trip.
  const [prevSig, setPrevSig] = useState(sig);
  if (sig !== prevSig) {
    setPrevSig(sig);
    setValues(buildValues());
    setDirty(new Set());
    setError(null);
  }

  function setVal(key: string, v: string) {
    setValues((p) => ({ ...p, [key]: v }));
    setDirty((p) => new Set(p).add(key));
  }

  async function save() {
    // Persist only CHANGED lines. A value edited back to the layout's own
    // authored line clears the override, so the line goes back to tracking the
    // layout instead of being frozen at an identical-looking copy.
    const byKey = new Map(lines.map((l) => [l.lineKey, l]));
    const payload: Record<string, string> = {};
    for (const key of dirty) {
      const v = values[key] ?? "";
      payload[key] = v.trim() === (byKey.get(key)?.authored ?? "").trim() ? "" : v;
    }
    if (Object.keys(payload).length === 0) {
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
          variantKey: thisDocOnly ? variantKey : baseKey,
          outputName,
          values: payload,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (${res.status})`);
        setPending(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setPending(false);
    }
  }

  const hasChanges = dirty.size > 0;
  if (lines.length === 0) {
    return (
      <p className="text-[11px] text-zinc-500">
        This output isn&apos;t built from an Output Builder layout, so it has no editable lines.
        Correct it with the fields above, or in its template.
      </p>
    );
  }

  // Group by page so a multi-page layout reads like the document.
  const pages: { pageId: string; title: string; rows: DocumentLine[] }[] = [];
  for (const l of lines) {
    const last = pages[pages.length - 1];
    if (last && last.pageId === l.pageId) last.rows.push(l);
    else pages.push({ pageId: l.pageId, title: l.pageTitle, rows: [l] });
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Every line this document prints. Type plain text, or use a{" "}
        <code className="rounded bg-zinc-100 px-1">{"{{token}}"}</code> — both work. Clearing a line
        back to its original reverts it to the layout.
      </p>

      {pages.map((p) => (
        <div key={p.pageId} className="space-y-1">
          {pages.length > 1 ? (
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              {p.title}
            </p>
          ) : null}
          {p.rows.map((l) => {
            const changed = (values[l.lineKey] ?? "") !== l.source;
            const isOverride = l.overridden || changed;
            const blank = !l.authored.trim() && !(values[l.lineKey] ?? "").trim();
            return (
              <div key={l.lineKey} className="flex items-start gap-2">
                <div className="w-32 shrink-0 pt-1">
                  {/* What this line prints right now — how a reviewer finds the
                      line they mean. Blank layout spacers say so, so they read
                      as "you can add text here" rather than as a bug. */}
                  <p
                    className="truncate text-[11px] text-zinc-600"
                    title={l.resolved || (blank ? "empty line" : "(prints nothing)")}
                  >
                    {l.resolved || (
                      <span className="italic text-zinc-400">{blank ? "empty" : "prints nothing"}</span>
                    )}
                  </p>
                  {isOverride ? (
                    <span className="mt-0.5 inline-block rounded-sm bg-amber-100 px-1 text-[9px] font-semibold uppercase text-amber-700">
                      edited
                    </span>
                  ) : null}
                  {l.kind === "graphic" ? (
                    <span
                      title="This line draws a barcode, symbol or logo — replacing it prints text instead."
                      className="mt-0.5 inline-block rounded-sm bg-zinc-100 px-1 text-[9px] font-semibold uppercase text-zinc-500"
                    >
                      graphic
                    </span>
                  ) : null}
                </div>
                <input
                  type="text"
                  value={values[l.lineKey] ?? ""}
                  disabled={pending}
                  maxLength={MAX_LINE_LENGTH}
                  onChange={(e) => setVal(l.lineKey, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  placeholder="empty line — type to add text"
                  className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 font-mono text-[11px]"
                />
              </div>
            );
          })}
        </div>
      ))}

      {isMultiDoc ? (
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-600">
          <input
            type="checkbox"
            checked={thisDocOnly}
            disabled={pending}
            onChange={(e) => setThisDocOnly(e.target.checked)}
          />
          Only this document — leave off to apply to every PDF this output renders
        </label>
      ) : null}

      {error ? <p className="text-[11px] font-medium text-red-700">{error}</p> : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={pending || !hasChanges}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Re-rendering…" : "Save & re-render"}
      </button>
    </div>
  );
}

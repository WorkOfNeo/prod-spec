"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";
import {
  LAUNDERING_ACTIONS,
  LAUNDERING_ACTION_LABELS,
  type LaunderingAction,
} from "@/lib/care-labels/actions";

// `svg` field on a WashSymbol row can hold either raw SVG markup (string
// starting with `<svg`) or a data URL (PNG/JPG/SVG base64). This helper
// produces a data URL suitable for any `<img src>` — either as-is when it
// already is one, or by base64-encoding the SVG markup.
function asDataUrl(svgOrDataUrl: string | null): string | null {
  if (!svgOrDataUrl) return null;
  if (svgOrDataUrl.startsWith("data:")) return svgOrDataUrl;
  if (typeof window === "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(svgOrDataUrl, "utf-8").toString("base64")}`;
  }
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgOrDataUrl)))}`;
}

// True when the stored value is a data URL (PNG/JPG/SVG-as-data-url),
// false when it's editable SVG markup. Drives the textarea vs upload-only
// UX in the dialog.
function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

type Symbol = {
  id: string;
  code: string;
  name: string;
  svg: string | null;
  mondayValue: string | null;
  active: boolean;
  // Laundering action this symbol concerns, + whether it's a "Do not …"
  // prohibition. A prohibition removes care lines tagged with the same action.
  action: LaunderingAction | null;
  restrictive: boolean;
  // Per-language care-text overrides. Keyed by ISO 639-1 (matches
  // Country.languageCode). Empty / missing langs fall back to `name`.
  translations: Record<string, string>;
};

// Language descriptor — `code` is the JSON key in translations, `name`
// is what gets shown next to each input.
type LanguageInfo = { code: string; name: string };

// Turn an unmapped Monday label into a reasonable starting `code` so the
// operator isn't stuck inventing one from scratch — the field stays fully
// editable in the dialog for when the auto-slug isn't the name they want.
function slugifyWashCode(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "") // strip accents (combining diacritical marks)
    .toLowerCase()
    // NFKD already decomposed "℃"/"℉" into "°C"/"°F" above, so dropping the
    // bare degree sign here leaves the unit letter — "40℃" becomes "40c",
    // which reads fine as part of a code.
    .replace(/°/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (slug || "symbol").slice(0, 64);
}

export function WashSymbolList({
  initialSymbols,
  knownLanguages,
  unmappedLabels,
  optionCount,
  missingArtwork,
}: {
  initialSymbols: Symbol[];
  knownLanguages: LanguageInfo[];
  unmappedLabels: string[];
  optionCount: number;
  missingArtwork: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Symbol | null>(null);
  // false = closed, true = blank "+ New symbol", string = creating from that
  // unmapped Monday label (dialog opens pre-filled with it).
  const [creating, setCreating] = useState<boolean | string>(false);

  async function seed() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/wash-symbols", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedStandard: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Double-confirm before nuking every symbol row. The first prompt
  // states the count + permanence; the second asks for typed agreement
  // so a stray click can't trigger it. Cleared rows can be re-added via
  // Seed afterwards.
  async function deleteAll() {
    const count = initialSymbols.length;
    if (count === 0) return;
    if (!confirm(`Delete ALL ${count} wash-care symbols? This wipes them from the database. SVGs uploaded into each row will be lost. You can re-seed the standard 16 afterwards.`)) {
      return;
    }
    const typed = prompt(`Type DELETE to confirm wiping ${count} symbols.`);
    if (typed !== "DELETE") {
      setErr("bulk delete cancelled");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/wash-symbols?confirm=all", { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {(unmappedLabels.length > 0 || missingArtwork.length > 0) && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {unmappedLabels.length > 0 && (
            <div className="rounded-lg border border-transparent bg-warn-soft p-4">
              <div className="text-sm font-semibold text-warn">
                {unmappedLabels.length} of {optionCount} Monday wash-care options don&rsquo;t
                resolve to a symbol
              </div>
              <p className="mt-1 text-xs text-warn">
                A style carrying one of these prints a dashed placeholder tile AND skips
                care-line suppression (the token carries no action — &ldquo;Do not iron&rdquo;
                wouldn&rsquo;t drop ironing lines). If this is the same instruction under a
                renamed Monday label, open the existing symbol&rsquo;s <strong>Edit</strong> below
                and update its <code className="font-mono">mondayValue</code> instead of creating
                a duplicate — otherwise, create the missing symbol.
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-warn">
                {unmappedLabels.map((label) => (
                  <li key={label} className="flex items-center justify-between gap-2">
                    <span className="truncate" title={label}>
                      · {label}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCreating(label)}
                      disabled={busy}
                      className="shrink-0 rounded border border-transparent bg-surface px-1.5 py-0.5 text-[11px] font-medium text-warn hover:bg-warn-soft disabled:opacity-50"
                    >
                      Create symbol
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {missingArtwork.length > 0 && (
            <div className="rounded-lg border border-transparent bg-warn-soft p-4">
              <div className="text-sm font-semibold text-warn">
                {missingArtwork.length} active symbols have no artwork yet
              </div>
              <p className="mt-1 text-xs text-warn">
                They render as dashed name tiles on every output that uses them — fine for
                review, blocked at approval. Upload the SVG on each symbol below.
              </p>
              <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto font-mono text-xs text-warn">
                {missingArtwork.map((code) => (
                  <li key={code}>· {code}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + New symbol
        </button>
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          Seed ISO 3758 codes (16)
        </button>
        <button
          type="button"
          onClick={deleteAll}
          disabled={busy || initialSymbols.length === 0}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-bad transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          title={
            initialSymbols.length === 0
              ? "Nothing to delete"
              : `Wipe all ${initialSymbols.length} symbols from the database`
          }
        >
          Delete all ({initialSymbols.length})
        </button>
        <span className="text-xs text-muted">
          Seeding creates placeholder rows for the standard codes — upload the SVG into each
          afterwards.
        </span>
        {err && <span className="text-xs text-bad">{err}</span>}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {initialSymbols.length === 0 ? (
          <div className="col-span-full rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
            No symbols yet. Click <strong>Seed ISO 3758 codes</strong> to pre-populate the standard
            16, or <strong>+ New symbol</strong> to add a custom one.
          </div>
        ) : (
          initialSymbols.map((s) => (
            <SymbolCard key={s.id} symbol={s} onEdit={() => setEditing(s)} />
          ))
        )}
      </div>

      {creating && (
        <SymbolDialog
          title={typeof creating === "string" ? `New symbol · ${creating}` : "New wash-care symbol"}
          mode="create"
          prefill={
            typeof creating === "string"
              ? { code: slugifyWashCode(creating), name: creating, mondayValue: creating }
              : undefined
          }
          knownLanguages={knownLanguages}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      {editing && (
        <SymbolDialog
          title={`Edit · ${editing.code}`}
          mode="edit"
          symbol={editing}
          knownLanguages={knownLanguages}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function SymbolCard({ symbol, onEdit }: { symbol: Symbol; onEdit: () => void }) {
  const dataUrl = asDataUrl(symbol.svg);
  return (
    <div
      className={`rounded-lg border p-3 ${
        symbol.active ? "border-line bg-surface" : "border-transparent bg-warn-soft opacity-70"
      }`}
    >
      <div className="flex h-20 items-center justify-center rounded-md bg-subtle">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt={symbol.code} className="h-14 w-14 object-contain" />
        ) : (
          <span className="text-xs text-warn">no image</span>
        )}
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-ink">{symbol.code}</div>
          <div className="truncate text-sm">{symbol.name}</div>
          {symbol.action && (
            <div className="mt-1">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  symbol.restrictive ? "bg-bad-soft text-bad" : "bg-accent-soft text-accent-text"
                }`}
              >
                {LAUNDERING_ACTION_LABELS[symbol.action]}
                {symbol.restrictive ? " · prohibition" : ""}
              </span>
            </div>
          )}
          <div className="mt-1 text-xs text-muted">
            Monday: {symbol.mondayValue ? <code className="font-mono">{symbol.mondayValue}</code> : "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-subtle"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function SymbolDialog({
  title,
  mode,
  symbol,
  prefill,
  knownLanguages,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  symbol?: Symbol;
  // Starting values for a fresh "create" dialog opened from an unmapped
  // Monday label — ignored in "edit" mode, where `symbol` already wins.
  // Every field stays editable; this only saves re-typing the label.
  prefill?: { code?: string; name?: string; mondayValue?: string };
  knownLanguages: LanguageInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(symbol?.code ?? prefill?.code ?? "");
  const [name, setName] = useState(symbol?.name ?? prefill?.name ?? "");
  const [svg, setSvg] = useState(symbol?.svg ?? "");
  const [mondayValue, setMondayValue] = useState(symbol?.mondayValue ?? prefill?.mondayValue ?? "");
  const [active, setActive] = useState(symbol?.active ?? true);
  const [action, setAction] = useState<LaunderingAction | "">(symbol?.action ?? "");
  const [restrictive, setRestrictive] = useState(symbol?.restrictive ?? false);
  const [translations, setTranslations] = useState<Record<string, string>>(
    symbol?.translations ?? {},
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Show one input per active Language, plus any extras the symbol
  // already has translations for (covers cases where a Language was
  // deactivated after the translation was entered). Active languages
  // come first in their canonical sortOrder; orphan codes follow.
  const languageInputs: LanguageInfo[] = (() => {
    const seen = new Set<string>();
    const out: LanguageInfo[] = [];
    for (const lang of knownLanguages) {
      if (seen.has(lang.code)) continue;
      seen.add(lang.code);
      out.push(lang);
    }
    for (const code of Object.keys(translations)) {
      if (seen.has(code)) continue;
      seen.add(code);
      // No DB row backing this code (deleted / never created) — show the
      // code as its own name so the operator can still see + clear it.
      out.push({ code, name: code });
    }
    return out;
  })();

  async function readFile(file: File) {
    if (file.size > 1_000_000) {
      setErr("File too large (max 1 MB)");
      return;
    }
    // Accept by extension OR mime type — browsers sometimes report empty
    // type for files dragged from Finder. SVG is preferred (vector, crisp
    // at any print size); PNG / JPG are accepted for print-shop-supplied
    // bitmap artwork.
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
    const isJpg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
    if (!isSvg && !isPng && !isJpg) {
      setErr(`Expected SVG, PNG, or JPG — got "${file.name}" (${file.type || "no type"})`);
      return;
    }
    if (isSvg) {
      // Store SVG as raw markup so the textarea can still edit it.
      const text = await file.text();
      setSvg(text);
    } else {
      // PNG / JPG → store as data URL. The loader detects the prefix and
      // embeds without re-encoding.
      const dataUrl = await readAsDataUrl(file);
      setSvg(dataUrl);
    }
    setErr(null);
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  // Whole-dialog drag-and-drop. Drop anywhere inside the modal and the
  // first SVG file goes into the SVG field. `dragenter` counter avoids
  // flicker when the cursor crosses child elements (each child fires
  // dragenter for itself + dragleave for the previous).
  const [dragDepth, setDragDepth] = useState(0);
  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
    setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragDepth((d) => {
      const next = d - 1;
      if (next <= 0) setDragOver(false);
      return Math.max(next, 0);
    });
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    // Required: without preventDefault the browser opens the file
    // instead of firing drop. Setting dropEffect changes the cursor.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    setDragDepth(0);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const url =
        mode === "create" ? "/api/admin/wash-symbols" : `/api/admin/wash-symbols/${symbol!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      // Drop empty-string translations on the way out — the server treats
      // missing keys and empty strings the same, but keeping the JSON tidy
      // helps when the row is inspected directly in Studio.
      const cleanTranslations = Object.fromEntries(
        Object.entries(translations).filter(([, v]) => v.trim().length > 0),
      );
      const payload =
        mode === "create"
          ? {
              code,
              name,
              svg: svg || null,
              mondayValue: mondayValue || null,
              action: action || null,
              restrictive,
              translations: cleanTranslations,
            }
          : {
              name,
              svg: svg || null,
              mondayValue: mondayValue || null,
              active,
              action: action || null,
              restrictive,
              translations: cleanTranslations,
            };
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ? `${body.error}` : `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!symbol) return;
    if (!confirm(`Delete "${symbol.code}"? This is permanent — toggling Active off is safer.`))
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/wash-symbols/${symbol.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  // Preview & format-aware rendering. `svg` may be raw SVG markup OR a
  // data URL (PNG/JPG/SVG). The textarea below is only useful for the
  // first case; for data URLs we show an upload-only path so the operator
  // doesn't have to look at a multi-kilobyte base64 string.
  const dataUrl = asDataUrl(svg);
  const storedAsDataUrl = !!svg && isDataUrl(svg);
  const dataUrlKind = storedAsDataUrl
    ? svg.startsWith("data:image/png")
      ? "PNG"
      : svg.startsWith("data:image/jpeg")
        ? "JPG"
        : svg.startsWith("data:image/svg+xml")
          ? "SVG (encoded)"
          : "image"
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(15_17_21/0.40)] px-4">
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`relative w-full max-w-2xl rounded-lg bg-surface p-6 shadow-2xl transition-shadow ${
          dragOver ? "ring-4 ring-accent ring-offset-2" : ""
        }`}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-zinc-900/5">
            <div className="rounded-md border-2 border-dashed border-ink bg-white/95 px-6 py-4 text-center text-sm font-medium text-ink">
              Drop SVG / PNG / JPG to attach
            </div>
          </div>
        )}
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted underline"
          >
            close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <label className="text-xs font-medium text-ink">
            Code
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={mode === "edit"}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-sm disabled:bg-subtle disabled:text-muted"
              placeholder="wash30"
            />
            <span className="mt-1 block font-normal text-muted">
              Stable identifier. Lowercase a-z, 0-9, _ or -. Immutable after create.
            </span>
          </label>
          <label className="text-xs font-medium text-ink">
            Display name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
              placeholder="Wash at 30°C"
            />
          </label>
        </div>

        <label className="mt-4 block text-xs font-medium text-ink">
          Monday value (optional)
          <input
            type="text"
            value={mondayValue}
            onChange={(e) => setMondayValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-sm"
            placeholder="(e.g. the option label Monday's wash-care column emits)"
          />
          <span className="mt-1 block font-normal text-muted">
            When ingest sees this exact string in the wash-care column it resolves to this symbol.
          </span>
        </label>

        <div className="mt-4 rounded-md border border-line bg-zinc-50/40 p-3">
          <div className="text-xs font-semibold text-ink">Care-instruction rule</div>
          <p className="mb-2 mt-0.5 text-[11px] text-muted">
            Classify which laundering action this symbol concerns. A{" "}
            <strong>prohibition</strong> symbol (&ldquo;Do not …&rdquo;) removes every care-label
            line tagged with the same action — e.g. <em>Do not iron</em> drops the ironing lines.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs font-medium text-ink">
              Action
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as LaunderingAction | "")}
                className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
              >
                <option value="">— none —</option>
                {LAUNDERING_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {LAUNDERING_ACTION_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
            {action !== "" && (
              <div className="flex items-end pb-1">
                <Toggle
                  checked={restrictive}
                  onChange={setRestrictive}
                  label={restrictive ? "Prohibition (Do not …)" : "Permissive"}
                />
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-ink">
              Image file (SVG, PNG, or JPG — drop anywhere in this dialog)
            </label>
            <input
              type="file"
              accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
              className="mt-1 block w-full text-xs"
            />
            <span className="mt-1 block text-[11px] text-muted">
              SVG is preferred — vector, crisp at any print size. PNG / JPG work for bitmap artwork
              supplied by the print shop. Max 1 MB.
            </span>

            {storedAsDataUrl ? (
              <div className="mt-3 rounded-md border border-line bg-subtle p-3 text-xs text-muted">
                <div>
                  Uploaded as <strong>{dataUrlKind}</strong>{" "}
                  <span className="text-muted">
                    ({Math.round(svg.length / 1024)} KB)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSvg("")}
                  className="mt-2 inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear and replace
                </button>
              </div>
            ) : (
              <label className="mt-3 block text-xs font-medium text-ink">
                Or paste SVG markup
                <textarea
                  value={svg}
                  onChange={(e) => setSvg(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-[11px]"
                  placeholder={"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">…</svg>"}
                />
              </label>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-ink">Preview</div>
            <div className="mt-1 flex h-40 items-center justify-center rounded-md border border-line bg-subtle">
              {dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt="preview" className="h-32 w-32 object-contain" />
              ) : (
                <span className="text-xs text-muted">no image yet</span>
              )}
            </div>
            {mode === "edit" && (
              <div className="mt-3">
                <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 rounded-md border border-line bg-zinc-50/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink">Translations</span>
            <span className="text-[11px] text-muted">
              {languageInputs.length === 0
                ? "Seed languages first to see slots here"
                : `${languageInputs.length} language${languageInputs.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {languageInputs.length === 0 ? (
            <p className="text-xs text-muted">
              No active languages — visit <code className="font-mono">/languages</code> and click{" "}
              <strong>Seed standard set</strong> to populate the language slots.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {languageInputs.map((lang) => (
                <label key={lang.code} className="text-xs font-medium text-ink">
                  {lang.name}{" "}
                  <span className="font-mono text-[11px] font-normal text-faint">
                    {lang.code}
                  </span>
                  <input
                    type="text"
                    value={translations[lang.code] ?? ""}
                    onChange={(e) =>
                      setTranslations((prev) => ({ ...prev, [lang.code]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-xs"
                    placeholder={lang.code === "en" ? "Wash at 30°C" : ""}
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {err && <p className="mt-3 text-xs text-bad">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={destroy}
                disabled={busy}
                className="text-xs text-bad underline disabled:opacity-50"
              >
                Delete permanently
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !code || !name}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

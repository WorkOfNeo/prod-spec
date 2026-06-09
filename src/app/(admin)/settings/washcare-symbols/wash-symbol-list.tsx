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

export function WashSymbolList({
  initialSymbols,
  knownLanguages,
}: {
  initialSymbols: Symbol[];
  knownLanguages: LanguageInfo[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Symbol | null>(null);
  const [creating, setCreating] = useState(false);

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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          + New symbol
        </button>
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Seed ISO 3758 codes (16)
        </button>
        <button
          type="button"
          onClick={deleteAll}
          disabled={busy || initialSymbols.length === 0}
          className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
          title={
            initialSymbols.length === 0
              ? "Nothing to delete"
              : `Wipe all ${initialSymbols.length} symbols from the database`
          }
        >
          Delete all ({initialSymbols.length})
        </button>
        <span className="text-xs text-zinc-500">
          Seeding creates placeholder rows for the standard codes — upload the SVG into each
          afterwards.
        </span>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {initialSymbols.length === 0 ? (
          <div className="col-span-full rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
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
          title="New wash-care symbol"
          mode="create"
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
        symbol.active ? "border-zinc-200 bg-white" : "border-amber-300 bg-amber-50 opacity-70"
      }`}
    >
      <div className="flex h-20 items-center justify-center rounded-md bg-zinc-50">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt={symbol.code} className="h-14 w-14 object-contain" />
        ) : (
          <span className="text-xs text-amber-700">no image</span>
        )}
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-zinc-700">{symbol.code}</div>
          <div className="truncate text-sm">{symbol.name}</div>
          {symbol.action && (
            <div className="mt-1">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  symbol.restrictive ? "bg-rose-100 text-rose-800" : "bg-sky-100 text-sky-700"
                }`}
              >
                {LAUNDERING_ACTION_LABELS[symbol.action]}
                {symbol.restrictive ? " · prohibition" : ""}
              </span>
            </div>
          )}
          <div className="mt-1 text-xs text-zinc-500">
            Monday: {symbol.mondayValue ? <code className="font-mono">{symbol.mondayValue}</code> : "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
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
  knownLanguages,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  symbol?: Symbol;
  knownLanguages: LanguageInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(symbol?.code ?? "");
  const [name, setName] = useState(symbol?.name ?? "");
  const [svg, setSvg] = useState(symbol?.svg ?? "");
  const [mondayValue, setMondayValue] = useState(symbol?.mondayValue ?? "");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`relative w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl transition-shadow ${
          dragOver ? "ring-4 ring-zinc-900 ring-offset-2" : ""
        }`}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-zinc-900/5">
            <div className="rounded-md border-2 border-dashed border-zinc-900 bg-white/95 px-6 py-4 text-center text-sm font-medium text-zinc-900">
              Drop SVG / PNG / JPG to attach
            </div>
          </div>
        )}
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 underline"
          >
            close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <label className="text-xs font-medium text-zinc-700">
            Code
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={mode === "edit"}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm disabled:bg-zinc-50 disabled:text-zinc-500"
              placeholder="wash30"
            />
            <span className="mt-1 block font-normal text-zinc-500">
              Stable identifier. Lowercase a-z, 0-9, _ or -. Immutable after create.
            </span>
          </label>
          <label className="text-xs font-medium text-zinc-700">
            Display name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="Wash at 30°C"
            />
          </label>
        </div>

        <label className="mt-4 block text-xs font-medium text-zinc-700">
          Monday value (optional)
          <input
            type="text"
            value={mondayValue}
            onChange={(e) => setMondayValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
            placeholder="(e.g. the option label Monday's wash-care column emits)"
          />
          <span className="mt-1 block font-normal text-zinc-500">
            When ingest sees this exact string in the wash-care column it resolves to this symbol.
          </span>
        </label>

        <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50/40 p-3">
          <div className="text-xs font-semibold text-zinc-700">Care-instruction rule</div>
          <p className="mb-2 mt-0.5 text-[11px] text-zinc-500">
            Classify which laundering action this symbol concerns. A{" "}
            <strong>prohibition</strong> symbol (&ldquo;Do not …&rdquo;) removes every care-label
            line tagged with the same action — e.g. <em>Do not iron</em> drops the ironing lines.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs font-medium text-zinc-700">
              Action
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as LaunderingAction | "")}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
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
            <label className="text-xs font-medium text-zinc-700">
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
            <span className="mt-1 block text-[10px] text-zinc-500">
              SVG is preferred — vector, crisp at any print size. PNG / JPG work for bitmap artwork
              supplied by the print shop. Max 1 MB.
            </span>

            {storedAsDataUrl ? (
              <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
                <div>
                  Uploaded as <strong>{dataUrlKind}</strong>{" "}
                  <span className="text-zinc-500">
                    ({Math.round(svg.length / 1024)} KB)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSvg("")}
                  className="mt-2 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium hover:bg-zinc-50"
                >
                  Clear and replace
                </button>
              </div>
            ) : (
              <label className="mt-3 block text-xs font-medium text-zinc-700">
                Or paste SVG markup
                <textarea
                  value={svg}
                  onChange={(e) => setSvg(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-[10px]"
                  placeholder={"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">…</svg>"}
                />
              </label>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-zinc-700">Preview</div>
            <div className="mt-1 flex h-40 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
              {dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt="preview" className="h-32 w-32 object-contain" />
              ) : (
                <span className="text-xs text-zinc-500">no image yet</span>
              )}
            </div>
            {mode === "edit" && (
              <div className="mt-3">
                <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-700">Translations</span>
            <span className="text-[10px] text-zinc-500">
              {languageInputs.length === 0
                ? "Seed languages first to see slots here"
                : `${languageInputs.length} language${languageInputs.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {languageInputs.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No active languages — visit <code className="font-mono">/languages</code> and click{" "}
              <strong>Seed standard set</strong> to populate the language slots.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {languageInputs.map((lang) => (
                <label key={lang.code} className="text-xs font-medium text-zinc-700">
                  {lang.name}{" "}
                  <span className="font-mono text-[10px] font-normal text-zinc-400">
                    {lang.code}
                  </span>
                  <input
                    type="text"
                    value={translations[lang.code] ?? ""}
                    onChange={(e) =>
                      setTranslations((prev) => ({ ...prev, [lang.code]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
                    placeholder={lang.code === "en" ? "Wash at 30°C" : ""}
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={destroy}
                disabled={busy}
                className="text-xs text-red-700 underline disabled:opacity-50"
              >
                Delete permanently
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !code || !name}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

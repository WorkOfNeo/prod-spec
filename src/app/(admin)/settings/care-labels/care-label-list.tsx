"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Toggle } from "@/components/toggle";
import { Combobox } from "@/components/ui/combobox";
import {
  explainCareLabelVisibility,
  type PresentSymbol,
} from "@/lib/care-labels/visibility";
import {
  LAUNDERING_ACTIONS,
  LAUNDERING_ACTION_LABELS,
  type LaunderingAction,
} from "@/lib/care-labels/actions";

type CareLabelRow = {
  id: string;
  sourceText: string;
  sortOrder: number;
  // Laundering action this line is about. A present restrictive symbol of the
  // same action removes it.
  action: LaunderingAction | null;
  showIfSymbols: string[];
  hideIfSymbols: string[];
  active: boolean;
};

type SymbolOption = {
  code: string;
  name: string;
  action: LaunderingAction | null;
  restrictive: boolean;
};
type LanguageInfo = { code: string; name: string };

// What the dialog knows about the English line's dictionary entry. Drives the
// translations panel shown below the Active toggle when editing a line.
type TranslationLookup =
  | { status: "idle" | "loading" | "none" | "error" }
  | {
      status: "found";
      sourceText: string;
      translations: Record<string, string>;
      lastSyncedAt: string | null;
    };

export function CareLabelList({
  symbols,
  languages,
  initialLabels,
}: {
  symbols: SymbolOption[];
  languages: LanguageInfo[];
  initialLabels: CareLabelRow[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<CareLabelRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nameByCode = useMemo(
    () => new Map(symbols.map((s) => [s.code, s.name])),
    [symbols],
  );

  async function seed() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/care-labels", {
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

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          + New care label
        </button>
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Seed standard set
        </button>
        <span className="text-xs text-zinc-500">
          {initialLabels.length} line{initialLabels.length === 1 ? "" : "s"}
        </span>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="w-10 px-4 py-2">#</th>
              <th className="px-4 py-2">English line</th>
              <th className="px-4 py-2">Visibility</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialLabels.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                  No care labels yet. Click <strong>Seed standard set</strong> for the shipped lines,
                  or <strong>+ New care label</strong> to add your own.
                </td>
              </tr>
            ) : (
              initialLabels.map((l) => (
                <tr key={l.id} className="border-t border-zinc-100 align-top">
                  <td className="px-4 py-2 text-xs text-zinc-400">{l.sortOrder}</td>
                  <td className="px-4 py-2 font-medium">{l.sourceText}</td>
                  <td className="px-4 py-2">
                    <VisibilitySummary label={l} nameByCode={nameByCode} />
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        l.active ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {l.active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(l)}
                      className="text-xs text-zinc-700 underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CareLabelPreview labels={initialLabels} symbols={symbols} />

      {creating && (
        <CareLabelDialog
          title="New care label"
          mode="create"
          symbols={symbols}
          languages={languages}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
      {editing && (
        <CareLabelDialog
          title="Edit care label"
          mode="edit"
          label={editing}
          symbols={symbols}
          languages={languages}
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

// Live preview / test bench. Pick up to six wash-care symbols (as a style
// would carry) and watch which care labels survive the show/hide rules —
// the exact logic the renderer uses (explainCareLabelVisibility is shared).
function CareLabelPreview({
  labels,
  symbols,
}: {
  labels: CareLabelRow[];
  symbols: SymbolOption[];
}) {
  const SLOTS = 6;
  const [picks, setPicks] = useState<string[]>(() => Array(SLOTS).fill(""));

  const nameByCode = useMemo(
    () => new Map(symbols.map((s) => [s.code, s.name])),
    [symbols],
  );
  const symbolByCode = useMemo(() => new Map(symbols.map((s) => [s.code, s])), [symbols]);
  const names = (codes: string[]) => codes.map((c) => nameByCode.get(c) ?? c).join(", ");

  // Resolve each picked code to the action + prohibition flag the engine needs
  // — the same shape the renderer builds from the catalogue.
  const present = useMemo<PresentSymbol[]>(
    () =>
      picks.filter(Boolean).map((code) => {
        const s = symbolByCode.get(code);
        return { code, action: s?.action ?? null, restrictive: s?.restrictive ?? false };
      }),
    [picks, symbolByCode],
  );
  const activeLabels = useMemo(() => labels.filter((l) => l.active), [labels]);

  // Searchable-popover options, shared across all six pickers. The code is
  // shown as a right-aligned hint so duplicate-named symbols stay distinct.
  const symbolOptions = useMemo(
    () =>
      symbols.map((s) => ({
        value: s.code,
        label: s.name,
        hint: <span className="font-mono text-[10px] text-zinc-400">{s.code}</span>,
      })),
    [symbols],
  );

  const evaluated = activeLabels.map((label) => ({
    label,
    ...explainCareLabelVisibility(label, present),
  }));
  const visibleLine = evaluated
    .filter((e) => e.visible)
    .map((e) => e.label.sourceText)
    .join(" / ");

  function setPick(i: number, code: string) {
    setPicks((prev) => prev.map((p, idx) => (idx === i ? code : p)));
  }

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700">Preview &amp; test</h2>
        {present.length > 0 && (
          <button
            type="button"
            onClick={() => setPicks(Array(SLOTS).fill(""))}
            className="text-xs text-zinc-500 underline"
          >
            Clear
          </button>
        )}
      </div>
      <p className="mt-1 max-w-3xl text-xs text-zinc-500">
        Pick the wash-care symbols a style carries and watch which care labels survive your
        show/hide rules — the exact logic the renderer uses. Text shown is the English source;
        per-language text resolves from the dictionary at print time.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {picks.map((pick, i) => (
          // Slots are positional and fixed in count; index key is fine.
          // eslint-disable-next-line react/no-array-index-key
          <div key={i}>
            <div className="mb-1 text-[11px] font-medium text-zinc-600">Symbol {i + 1}</div>
            <Combobox
              mode="single"
              options={symbolOptions}
              value={pick || null}
              onChange={(v) => setPick(i, v ?? "")}
              placeholder="Search…"
              emptyLabel="No symbols"
            />
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4">
        <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
          Printed care line (EN)
        </div>
        <div className="mt-1 text-sm text-zinc-800">
          {visibleLine || <span className="text-zinc-400">— nothing visible —</span>}
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Care label</th>
              <th className="px-4 py-2">Shown?</th>
              <th className="px-4 py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            {evaluated.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                  No active care labels to preview.
                </td>
              </tr>
            ) : (
              evaluated.map(({ label, visible, reason, matchedCodes }) => (
                <tr
                  key={label.id}
                  className={`border-t border-zinc-100 ${visible ? "" : "bg-zinc-50/60"}`}
                >
                  <td
                    className={`px-4 py-2 ${
                      visible ? "text-zinc-800" : "text-zinc-400 line-through"
                    }`}
                  >
                    {label.sourceText}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        visible ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                      }`}
                    >
                      {visible ? "shown" : "hidden"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {reason === "always" && "always shown"}
                    {reason === "action-prohibited" &&
                      `removed by ${names(matchedCodes)} (${
                        label.action ? LAUNDERING_ACTION_LABELS[label.action].toLowerCase() : ""
                      } prohibited)`}
                    {reason === "show-gate-met" && `show-if met: ${names(matchedCodes)}`}
                    {reason === "hidden-by" && `hidden by: ${names(matchedCodes)}`}
                    {reason === "show-gate-unmet" &&
                      `needs one of: ${names(label.showIfSymbols)}`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VisibilitySummary({
  label,
  nameByCode,
}: {
  label: CareLabelRow;
  nameByCode: Map<string, string>;
}) {
  const names = (codes: string[]) =>
    codes.map((c) => nameByCode.get(c) ?? c).join(", ");
  const hasManual = label.showIfSymbols.length > 0 || label.hideIfSymbols.length > 0;
  if (!label.action && !hasManual) {
    return <span className="text-xs text-zinc-400">Always shown</span>;
  }
  return (
    <div className="space-y-0.5 text-xs">
      {label.action && (
        <div className="text-zinc-700">
          Action:{" "}
          <span className="font-medium">{LAUNDERING_ACTION_LABELS[label.action]}</span>
          <span className="text-zinc-400"> · removed by its prohibition</span>
        </div>
      )}
      {label.showIfSymbols.length > 0 && (
        <div className="text-emerald-700">
          Show if: <span className="text-zinc-600">{names(label.showIfSymbols)}</span>
        </div>
      )}
      {label.hideIfSymbols.length > 0 && (
        <div className="text-rose-700">
          Hide if: <span className="text-zinc-600">{names(label.hideIfSymbols)}</span>
        </div>
      )}
    </div>
  );
}

function CareLabelDialog({
  title,
  mode,
  label,
  symbols,
  languages,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  label?: CareLabelRow;
  symbols: SymbolOption[];
  languages: LanguageInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sourceText, setSourceText] = useState(label?.sourceText ?? "");
  const [sortOrder, setSortOrder] = useState<string>(
    label ? String(label.sortOrder) : "",
  );
  const [action, setAction] = useState<LaunderingAction | "">(label?.action ?? "");
  const [showIfSymbols, setShowIfSymbols] = useState<string[]>(label?.showIfSymbols ?? []);
  const [hideIfSymbols, setHideIfSymbols] = useState<string[]>(label?.hideIfSymbols ?? []);
  const [active, setActive] = useState(label?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Seed "loading" up front when opening on an existing line so the panel
  // reads as intentional rather than flashing empty before the fetch lands.
  const [lookup, setLookup] = useState<TranslationLookup>(
    mode === "edit" && (label?.sourceText ?? "").trim()
      ? { status: "loading" }
      : { status: "idle" },
  );

  // Resolve the English line against the Translation dictionary so the editor
  // sees the full source line and every per-language string inline — the same
  // entry the renderer prints. Debounced and abort-guarded so editing the line
  // re-resolves live without racing stale responses. Edit-only: the panel sits
  // under the Active toggle, which itself only shows when editing. All state
  // updates live inside the debounce callback (never synchronously in the
  // effect body) to avoid cascading renders.
  useEffect(() => {
    if (mode !== "edit") return;
    const text = sourceText.trim();
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!text) {
        setLookup({ status: "none" });
        return;
      }
      setLookup({ status: "loading" });
      try {
        const res = await fetch(
          `/api/admin/translations/lookup?text=${encodeURIComponent(text)}`,
        );
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLookup({ status: "error" });
        } else if (!body.found) {
          setLookup({ status: "none" });
        } else {
          setLookup({
            status: "found",
            sourceText: body.sourceText,
            translations: (body.translations ?? {}) as Record<string, string>,
            lastSyncedAt: body.lastSyncedAt ?? null,
          });
        }
      } catch {
        if (!cancelled) setLookup({ status: "error" });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceText, mode]);

  function toggle(list: string[], setList: (v: string[]) => void, code: string) {
    setList(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const url = mode === "create" ? "/api/admin/care-labels" : `/api/admin/care-labels/${label!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload: Record<string, unknown> = {
        sourceText,
        action: action || null,
        showIfSymbols,
        hideIfSymbols,
      };
      if (sortOrder.trim() !== "") payload.sortOrder = Number(sortOrder);
      if (mode === "edit") payload.active = active;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!label) return;
    if (!confirm(`Delete this care label? This is permanent — disabling it is safer.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/care-labels/${label.id}`, { method: "DELETE" });
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="my-8 w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-4">
          <label className="text-xs font-medium text-zinc-700">
            English line
            <input
              type="text"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="wash and iron inside out"
            />
            <span className="mt-1 block font-normal text-zinc-500">
              Also the key into the Translations dictionary for per-language text.
            </span>
          </label>
          <label className="text-xs font-medium text-zinc-700">
            Order
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="mt-1 w-20 rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="auto"
            />
          </label>
        </div>

        <div className="mt-5">
          <label className="text-xs font-medium text-zinc-700">
            Action
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as LaunderingAction | "")}
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm sm:w-72"
            >
              <option value="">— none (always shown) —</option>
              {LAUNDERING_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {LAUNDERING_ACTION_LABELS[a]}
                </option>
              ))}
            </select>
            <span className="mt-1 block font-normal text-zinc-500">
              When set, this line is removed if the style carries a &ldquo;Do not …&rdquo; symbol of
              the same action. Split combined lines (e.g. wash + iron) into one line per action so
              only the conflicting part drops.
            </span>
          </label>
        </div>

        <details className="mt-5 rounded-md border border-zinc-200 bg-zinc-50/40 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-zinc-700">
            Advanced override — show / hide by specific symbols
          </summary>
          <p className="mt-1 text-[11px] text-zinc-500">
            Optional manual rules layered on top of the action above, matched against specific
            symbol codes. A hide (manual or action) always wins.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SymbolPicker
              title="Show only if present"
              hint="Empty = no requirement. Shows when any ticked symbol is on the style."
              accent="emerald"
              symbols={symbols}
              selected={showIfSymbols}
              onToggle={(code) => toggle(showIfSymbols, setShowIfSymbols, code)}
            />
            <SymbolPicker
              title="Hide if present"
              hint="Hidden when any ticked symbol is on the style. Hiding wins over showing."
              accent="rose"
              symbols={symbols}
              selected={hideIfSymbols}
              onToggle={(code) => toggle(hideIfSymbols, setHideIfSymbols, code)}
            />
          </div>
        </details>

        {mode === "edit" && (
          <div className="mt-4">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
          </div>
        )}

        {mode === "edit" && <TranslationsPanel lookup={lookup} languages={languages} />}

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
              disabled={busy || !sourceText.trim()}
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

function SymbolPicker({
  title,
  hint,
  accent,
  symbols,
  selected,
  onToggle,
}: {
  title: string;
  hint: string;
  accent: "emerald" | "rose";
  symbols: SymbolOption[];
  selected: string[];
  onToggle: (code: string) => void;
}) {
  const ring = accent === "emerald" ? "text-emerald-700" : "text-rose-700";
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3">
      <div className={`text-xs font-semibold ${ring}`}>{title}</div>
      <p className="mb-2 mt-0.5 text-[11px] text-zinc-500">{hint}</p>
      {symbols.length === 0 ? (
        <p className="text-xs text-zinc-500">No wash-care symbols defined yet.</p>
      ) : (
        <div className="max-h-56 overflow-y-auto pr-1">
          {symbols.map((s) => (
            <label key={s.code} className="flex items-center gap-2 py-0.5 text-xs text-zinc-700">
              <input
                type="checkbox"
                checked={selected.includes(s.code)}
                onChange={() => onToggle(s.code)}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="font-mono text-[10px] text-zinc-400">{s.code}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Shows the English line's dictionary entry — the full source line and every
// non-English translation — so an editor can confirm what will print in each
// language without leaving the dialog. English is omitted: it's already the
// line being edited above.
function TranslationsPanel({
  lookup,
  languages,
}: {
  lookup: TranslationLookup;
  languages: LanguageInfo[];
}) {
  return (
    <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-zinc-700">Translations</div>
        {lookup.status === "loading" && (
          <span className="text-[11px] text-zinc-400">Loading…</span>
        )}
      </div>

      {lookup.status === "error" && (
        <p className="mt-1 text-[11px] text-red-600">Couldn&rsquo;t load translations — try again.</p>
      )}
      {lookup.status === "none" && (
        <p className="mt-1 text-[11px] text-zinc-500">
          No dictionary entry for this line yet. Add the phrase on the{" "}
          <Link href="/translations" className="underline">
            Translations
          </Link>{" "}
          board so it prints in every language.
        </p>
      )}
      {lookup.status === "found" && (
        <TranslationsGrid lookup={lookup} languages={languages} />
      )}
    </div>
  );
}

function TranslationsGrid({
  lookup,
  languages,
}: {
  lookup: Extract<TranslationLookup, { status: "found" }>;
  languages: LanguageInfo[];
}) {
  const nameByCode = new Map(languages.map((l) => [l.code, l.name]));
  // Active languages first (in nav order), then any orphan codes the entry
  // carries that aren't in the active set. English is the source line itself,
  // so it's skipped here. Mirrors the Translations board's View dialog.
  const orderedCodes: string[] = [];
  const seen = new Set<string>();
  for (const l of languages) {
    if (l.code !== "en" && lookup.translations[l.code] !== undefined) {
      orderedCodes.push(l.code);
      seen.add(l.code);
    }
  }
  for (const code of Object.keys(lookup.translations)) {
    if (code !== "en" && !seen.has(code)) orderedCodes.push(code);
  }

  return (
    <>
      <p className="mt-1 text-[11px] text-zinc-500">
        {lookup.sourceText}
        {orderedCodes.length > 0 && ` · ${orderedCodes.length} languages`}
      </p>
      {orderedCodes.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-500">
          Matched the dictionary, but no non-English translations are filled in yet.
        </p>
      ) : (
        <div className="mt-2 grid max-h-72 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {orderedCodes.map((code) => (
            <div key={code} className="rounded-md border border-zinc-100 bg-white px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                {nameByCode.get(code) ?? code}{" "}
                <span className="font-mono normal-case">{code}</span>
              </div>
              <div className="text-sm text-zinc-800">{lookup.translations[code] || "—"}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

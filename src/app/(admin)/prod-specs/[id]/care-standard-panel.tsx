"use client";

import { useMemo, useState } from "react";
import {
  explainCareLabelVisibility,
  type PresentSymbol,
} from "@/lib/care-labels/visibility";
import { LAUNDERING_ACTION_LABELS, type LaunderingAction } from "@/lib/care-labels/actions";

// =====================================================
// "Care instructions — generated from the standard."
//
// The catalogue at /settings/care-labels IS the source of the printed care
// text: every active line, ordered, filtered per product by the style's
// wash-care symbols (action prohibition → hide-if → show-if), translated
// per language from the Translation board. This panel makes that engine
// VISIBLE while editing a prod spec:
//
//   • a wash-symbol test picker — pick what a style would carry, watch
//     which lines survive (same pure rule the renderer uses)
//   • the composed line per output language, with English-fallback gaps
//     flagged (a missing translation prints English under a foreign flag)
//   • the legacy free-text override DEMOTED behind a disclosure, loudly
//     badged — an override beats the standard verbatim, per language
// =====================================================

export type PanelCareLabel = {
  id: string;
  sourceText: string;
  sortOrder: number;
  action: LaunderingAction | null;
  showIfSymbols: string[];
  hideIfSymbols: string[];
};

export type PanelSymbol = {
  code: string;
  name: string;
  action: LaunderingAction | null;
  restrictive: boolean;
};

export function CareStandardPanel({
  careLabels,
  symbols,
  translationsByLabel,
  languages,
  selectedLanguages,
  careByLang,
  onChangeCareByLang,
}: {
  careLabels: PanelCareLabel[];
  symbols: PanelSymbol[];
  // labelId → { langCode → translated line } (from the Translation board).
  translationsByLabel: Record<string, Record<string, string>>;
  languages: Array<{ code: string; name: string }>;
  // The prod spec's selected output languages (empty ⇒ template defaults;
  // the panel then previews every active language).
  selectedLanguages: string[];
  careByLang: Record<string, string>;
  onChangeCareByLang: (code: string, value: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const present: PresentSymbol[] = useMemo(
    () =>
      symbols
        .filter((s) => picked.has(s.code))
        .map((s) => ({ code: s.code, action: s.action, restrictive: s.restrictive })),
    [symbols, picked],
  );

  const rows = useMemo(
    () =>
      careLabels.map((label) => ({
        label,
        verdict: explainCareLabelVisibility(label, present),
      })),
    [careLabels, present],
  );
  const visibleLabels = rows.filter((r) => r.verdict.visible).map((r) => r.label);

  const previewLangs =
    selectedLanguages.length > 0
      ? languages.filter((l) => selectedLanguages.includes(l.code))
      : languages;

  function togglePick(code: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function reasonText(verdict: ReturnType<typeof explainCareLabelVisibility>): string {
    switch (verdict.reason) {
      case "action-prohibited":
        return `removed by ${verdict.matchedCodes.join(", ")} (prohibition)`;
      case "hidden-by":
        return `hidden by ${verdict.matchedCodes.join(", ")}`;
      case "show-gate-unmet":
        return "show-if not met";
      case "show-gate-met":
        return `shown by ${verdict.matchedCodes.join(", ")}`;
      default:
        return "always shown";
    }
  }

  if (careLabels.length === 0) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        No active care labels — visit <code className="font-mono">/settings/care-labels</code> and
        click <strong>Seed standard set</strong>. The standard catalogue is what prints; this prod
        spec has nothing to compose from yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 1 — symbol test picker */}
      <div>
        <div className="text-xs font-medium text-zinc-700">
          Test with wash-care symbols
          <span className="ml-2 font-normal text-zinc-400">
            pick what a style would carry — the lines below filter live, exactly like the print
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {symbols.map((s) => {
            const active = picked.has(s.code);
            return (
              <button
                key={s.code}
                type="button"
                onClick={() => togglePick(s.code)}
                title={`${s.name}${s.action ? ` · ${LAUNDERING_ACTION_LABELS[s.action]}` : ""}${s.restrictive ? " · prohibition" : ""}`}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                  active
                    ? s.restrictive
                      ? "border-red-300 bg-red-50 text-red-800"
                      : "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-400"
                }`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2 — the standard lines + live verdicts */}
      <div className="overflow-hidden rounded-md border border-zinc-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left">
              <th className="px-3 py-1.5 font-medium text-zinc-500">Care label (standard)</th>
              <th className="px-3 py-1.5 font-medium text-zinc-500">Action</th>
              <th className="px-3 py-1.5 font-medium text-zinc-500">Prints?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, verdict }) => (
              <tr
                key={label.id}
                className={`border-b border-zinc-100 last:border-b-0 ${
                  verdict.visible ? "" : "bg-zinc-50/60 text-zinc-400"
                }`}
              >
                <td className="px-3 py-1.5">{label.sourceText}</td>
                <td className="px-3 py-1.5 text-zinc-500">
                  {label.action ? LAUNDERING_ACTION_LABELS[label.action] : "—"}
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className={`inline-flex items-center gap-1.5 ${
                      verdict.visible ? "text-emerald-700" : "text-zinc-400"
                    }`}
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        verdict.visible ? "bg-emerald-500" : "bg-zinc-300"
                      }`}
                    />
                    {reasonText(verdict)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3 — composed line per output language + coverage + demoted override */}
      <div>
        <div className="text-xs font-medium text-zinc-700">
          Printed line per language
          <span className="ml-2 font-normal text-zinc-400">
            visible lines joined with &ldquo; / &rdquo;, translated from the Translation board
          </span>
        </div>
        <ul className="mt-2 flex flex-col gap-2">
          {previewLangs.map(({ code, name }) => {
            const parts = visibleLabels.map((label) => {
              const t =
                code === "en" ? label.sourceText : translationsByLabel[label.id]?.[code]?.trim();
              return { text: t || label.sourceText, fallback: code !== "en" && !t };
            });
            const fallbackCount = parts.filter((p) => p.fallback).length;
            const override = (careByLang[code] ?? "").trim();
            return (
              <li key={code} className="rounded-md border border-zinc-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-zinc-700">
                    {name} <span className="font-mono font-normal text-zinc-400">({code})</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {override && (
                      <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                        overridden
                      </span>
                    )}
                    {!override && fallbackCount > 0 && (
                      <span
                        className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                        title="Missing Translation-board entries — these parts print in ENGLISH under this language's flag until translated."
                      >
                        {fallbackCount} of {parts.length} untranslated → prints English
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 text-xs leading-relaxed">
                  {override ? (
                    <span className="text-amber-900">{override}</span>
                  ) : parts.length === 0 ? (
                    <span className="italic text-zinc-400">
                      nothing prints — every line is filtered out for the picked symbols
                    </span>
                  ) : (
                    parts.map((p, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-zinc-300"> / </span>}
                        <span
                          className={
                            p.fallback
                              ? "underline decoration-amber-400 decoration-dotted underline-offset-2 text-amber-800"
                              : "text-zinc-800"
                          }
                          title={p.fallback ? "No translation — prints the English source line" : undefined}
                        >
                          {p.text}
                        </span>
                      </span>
                    ))
                  )}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-zinc-400 hover:text-zinc-600">
                    {override ? "Edit override" : "Override standard text"}
                  </summary>
                  <div className="mt-1.5">
                    <textarea
                      value={careByLang[code] ?? ""}
                      onChange={(e) => onChangeCareByLang(code, e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-xs"
                      placeholder="Leave empty to use the standard (recommended)"
                    />
                    {override && (
                      <button
                        type="button"
                        onClick={() => onChangeCareByLang(code, "")}
                        className="mt-1 text-[11px] text-red-700 underline"
                      >
                        Clear override → use standard
                      </button>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

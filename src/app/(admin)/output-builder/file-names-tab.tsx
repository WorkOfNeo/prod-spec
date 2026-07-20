"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  LayoutCollisionSummary,
  StyleAnalysis,
  CollisionGroup,
} from "@/lib/output-layouts/filename-collisions";

// =====================================================
// Output Builder → "File names". Surfaces layouts whose per-EAN split resolves
// several documents to the SAME file name — the supplier push PUTs by name, so
// every collision is a file that never reached the supplier folder.
//
// Two verdicts, deliberately separated (see filename-collisions.ts):
//   broken — today's expression still collides → edit the layout
//   stale  — expression already fixed, old jobs still carry the damage →
//            regenerate the affected styles
// =====================================================

const VERDICT_STYLE = {
  broken: { chip: "bg-red-100 text-red-700", label: "Still colliding" },
  stale: { chip: "bg-amber-100 text-amber-800", label: "Fixed — needs regeneration" },
  unknown: { chip: "bg-zinc-100 text-zinc-600", label: "Could not re-check" },
} as const;

function RowsTable({ group }: { group: CollisionGroup }) {
  // Grey out the columns that are IDENTICAL across the colliding rows — those
  // are the ones that cannot separate the files, which is the whole question
  // the operator is here to answer.
  const varies = (t: "size" | "colourName" | "ean13") => group.varyingTokens.includes(t);
  const cell = (t: "size" | "colourName" | "ean13", value: string) => (
    <td className={varies(t) ? "px-3 py-1.5 font-medium text-zinc-900" : "px-3 py-1.5 text-zinc-400"}>
      {value || "—"}
    </td>
  );
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="px-3 py-1 font-medium">Document</th>
          <th className="px-3 py-1 font-medium">{"{{size}}"}</th>
          <th className="px-3 py-1 font-medium">{"{{colourName}}"}</th>
          <th className="px-3 py-1 font-medium">{"{{ean13}}"}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {group.rows.map((r) => (
          <tr key={r.suffix}>
            <td className="px-3 py-1.5 font-mono text-zinc-600">{r.suffix}</td>
            {cell("size", r.size)}
            {cell("colourName", r.colourName)}
            {cell("ean13", r.ean13)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnalysisBlock({ analysis }: { analysis: StyleAnalysis }) {
  if (analysis.collisions.length === 0) {
    return (
      <p className="mt-2 text-xs text-emerald-700">
        Re-checked against the current template — all {analysis.rows.length} documents resolve to unique names.
        Regenerate this style to replace the old files.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-3">
      {analysis.collisions.map((g) => (
        <div key={g.fileName} className="rounded-md border border-zinc-200 bg-white p-2">
          <p className="font-mono text-xs text-zinc-800">
            {g.fileName} <span className="text-red-600">×{g.rows.length}</span>
          </p>
          <RowsTable group={g} />
        </div>
      ))}
    </div>
  );
}

function LayoutCard({ summary }: { summary: LayoutCollisionSummary }) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [perStyle, setPerStyle] = useState<Record<string, StyleAnalysis | "none">>({});
  const v = VERDICT_STYLE[summary.verdict];

  async function recheck(styleId: string) {
    setChecking(styleId);
    try {
      const res = await fetch(
        `/api/admin/output-layouts/${summary.layoutId}/filename-check?styleId=${styleId}`,
      );
      const body = (await res.json().catch(() => ({}))) as { analysis?: StyleAnalysis | null };
      setPerStyle((p) => ({ ...p, [styleId]: body.analysis ?? "none" }));
    } finally {
      setChecking(null);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/output-builder/${summary.layoutId}`}
              className="truncate text-sm font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2"
            >
              {summary.layoutName}
            </Link>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${v.chip}`}>{v.label}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-500">{summary.expression || "(no custom file name)"}</p>
          <p className="mt-1.5 text-xs text-zinc-600">
            <span className="font-semibold text-zinc-900">{summary.filesLost}</span> file
            {summary.filesLost === 1 ? "" : "s"} overwritten across{" "}
            <span className="font-semibold text-zinc-900">{summary.stylesAffected}</span> style
            {summary.stylesAffected === 1 ? "" : "s"}
          </p>
          {summary.fix ? (
            <p
              className={`mt-1.5 text-xs ${summary.verdict === "broken" ? "text-red-700" : "text-amber-800"}`}
            >
              → {summary.fix}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          {open ? "Hide styles" : `Show styles (${summary.samples.length})`}
        </button>
      </div>

      {open ? (
        <div className="space-y-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-4">
          {summary.sampleAnalysis && summary.sampleAnalysis.collisions.length > 0 ? (
            <div className="mb-3">
              <p className="text-xs font-medium text-zinc-700">
                Why these are indistinguishable — greyed columns are identical on every document:
              </p>
              <AnalysisBlock analysis={summary.sampleAnalysis} />
            </div>
          ) : null}

          {summary.samples.map((s) => {
            const a = perStyle[s.styleId];
            return (
              <div key={`${s.styleId}-${s.fileName}`} className="rounded-md border border-zinc-200 bg-white px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/styles/${s.styleId}/review`}
                      className="text-xs font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2"
                    >
                      {s.styleName}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-zinc-500">{s.fileName}</span>
                    <span className="ml-2 text-xs text-red-600">×{s.docCount}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => recheck(s.styleId)}
                    disabled={checking === s.styleId}
                    className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {checking === s.styleId ? "Checking…" : "Re-check"}
                  </button>
                </div>
                {a === "none" ? (
                  <p className="mt-1.5 text-xs text-zinc-500">
                    This layout no longer splits per EAN, or has no custom file name — nothing to check.
                  </p>
                ) : a ? (
                  <AnalysisBlock analysis={a} />
                ) : null}
              </div>
            );
          })}
          {summary.stylesAffected > summary.samples.length ? (
            <p className="text-xs text-zinc-500">
              + {summary.stylesAffected - summary.samples.length} more style
              {summary.stylesAffected - summary.samples.length === 1 ? "" : "s"} affected
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FileNamesTab({ summaries }: { summaries: LayoutCollisionSummary[] }) {
  const broken = summaries.filter((s) => s.verdict === "broken");
  const stale = summaries.filter((s) => s.verdict !== "broken");

  if (summaries.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4">
        <p className="text-sm font-medium text-emerald-800">No file-name collisions</p>
        <p className="mt-1 text-sm text-emerald-700">
          Every split layout resolves each of its documents to a unique file name.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="max-w-3xl rounded-lg border border-zinc-200 bg-zinc-50 px-5 py-4">
        <p className="text-sm text-zinc-700">
          A layout set to <strong>split per EAN</strong> emits one PDF per repetition row, but the file name is
          resolved against each row separately. When the name contains no token that actually <em>differs</em>{" "}
          between rows, every document gets the same name — and because the supplier push uploads by name, only
          the last one survives in SharePoint. The counts below are files that never reached the supplier.
        </p>
      </div>

      {broken.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-zinc-900">Still colliding — edit the template</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Today&apos;s file name still resolves to duplicates. Regenerating first would just lose the same files
            again.
          </p>
          <div className="mt-3 space-y-3">
            {broken.map((s) => (
              <LayoutCard key={s.layoutId} summary={s} />
            ))}
          </div>
        </section>
      ) : null}

      {stale.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-zinc-900">Template already fixed — regenerate</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            The current file name is unique. These styles were generated under the old one, so the supplier folder
            is still short until they re-run.
          </p>
          <div className="mt-3 space-y-3">
            {stale.map((s) => (
              <LayoutCard key={s.layoutId} summary={s} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

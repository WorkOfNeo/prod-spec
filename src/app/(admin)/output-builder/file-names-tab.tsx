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
    <td className={varies(t) ? "px-3 py-1.5 font-medium text-ink" : "px-3 py-1.5 text-faint"}>
      {value || "—"}
    </td>
  );
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead className="text-muted">
        <tr>
          <th className="px-3 py-1 font-medium">Document</th>
          <th className="px-3 py-1 font-medium">{"{{size}}"}</th>
          <th className="px-3 py-1 font-medium">{"{{colourName}}"}</th>
          <th className="px-3 py-1 font-medium">{"{{ean13}}"}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {group.rows.map((r) => (
          <tr key={r.suffix}>
            <td className="px-3 py-1.5 font-mono text-muted">{r.suffix}</td>
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
      <p className="mt-2 text-xs text-good">
        Re-checked against the current template — all {analysis.rows.length} documents resolve to unique names.
        Regenerate this style to replace the old files.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-3">
      {analysis.collisions.map((g) => (
        <div key={g.fileName} className="rounded-md border border-line bg-surface p-2">
          <p className="font-mono text-xs text-ink">
            {g.fileName} <span className="text-bad">×{g.rows.length}</span>
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
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/output-builder/${summary.layoutId}`}
              className="truncate text-sm font-medium text-ink underline decoration-zinc-300 underline-offset-2"
            >
              {summary.layoutName}
            </Link>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${v.chip}`}>{v.label}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-muted">{summary.expression || "(no custom file name)"}</p>
          <p className="mt-1.5 text-xs text-muted">
            <span className="font-semibold text-ink">{summary.filesLost}</span> file
            {summary.filesLost === 1 ? "" : "s"} overwritten across{" "}
            <span className="font-semibold text-ink">{summary.stylesAffected}</span> style
            {summary.stylesAffected === 1 ? "" : "s"}
          </p>
          {summary.fix ? (
            <p
              className={`mt-1.5 text-xs ${summary.verdict === "broken" ? "text-bad" : "text-warn"}`}
            >
              → {summary.fix}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle"
        >
          {open ? "Hide styles" : `Show styles (${summary.samples.length})`}
        </button>
      </div>

      {open ? (
        <div className="space-y-2 border-t border-line bg-zinc-50/60 px-5 py-4">
          {summary.sampleAnalysis && summary.sampleAnalysis.collisions.length > 0 ? (
            <div className="mb-3">
              <p className="text-xs font-medium text-ink">
                Why these are indistinguishable — greyed columns are identical on every document:
              </p>
              <AnalysisBlock analysis={summary.sampleAnalysis} />
            </div>
          ) : null}

          {summary.samples.map((s) => {
            const a = perStyle[s.styleId];
            return (
              <div key={`${s.styleId}-${s.fileName}`} className="rounded-md border border-line bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/styles/${s.styleId}/review`}
                      className="text-xs font-medium text-ink underline decoration-zinc-300 underline-offset-2"
                    >
                      {s.styleName}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-muted">{s.fileName}</span>
                    <span className="ml-2 text-xs text-bad">×{s.docCount}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => recheck(s.styleId)}
                    disabled={checking === s.styleId}
                    className="shrink-0 rounded border border-line px-2 py-1 text-xs text-ink hover:bg-subtle disabled:opacity-50"
                  >
                    {checking === s.styleId ? "Checking…" : "Re-check"}
                  </button>
                </div>
                {a === "none" ? (
                  <p className="mt-1.5 text-xs text-muted">
                    This layout no longer splits per EAN, or has no custom file name — nothing to check.
                  </p>
                ) : a ? (
                  <AnalysisBlock analysis={a} />
                ) : null}
              </div>
            );
          })}
          {summary.stylesAffected > summary.samples.length ? (
            <p className="text-xs text-muted">
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
      <div className="mt-6 rounded-lg border border-transparent bg-good-soft px-5 py-4">
        <p className="text-sm font-medium text-good">No file-name collisions</p>
        <p className="mt-1 text-sm text-good">
          Every split layout resolves each of its documents to a unique file name.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="max-w-3xl rounded-lg border border-line bg-subtle px-5 py-4">
        <p className="text-sm text-ink">
          A layout set to <strong>split per EAN</strong> emits one PDF per repetition row, but the file name is
          resolved against each row separately. When the name contains no token that actually <em>differs</em>{" "}
          between rows, every document gets the same name — and because the supplier push uploads by name, only
          the last one survives in SharePoint. The counts below are files that never reached the supplier.
        </p>
      </div>

      {broken.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-ink">Still colliding — edit the template</h2>
          <p className="mt-0.5 text-xs text-muted">
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
          <h2 className="text-sm font-semibold text-ink">Template already fixed — regenerate</h2>
          <p className="mt-0.5 text-xs text-muted">
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

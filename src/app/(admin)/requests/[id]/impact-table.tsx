"use client";

import { Truck, TriangleAlert } from "lucide-react";
import { IMPACT_REVIEW_STATUSES, type ImpactRow, type ImpactSummary } from "@/lib/change-requests/types";
import { REVIEW_STATUS_LABEL, count, docSuffix, plural } from "./shared";

// The impact list of a draft (design §5.4): how many documents print this
// layout, how many the draft changes, and the changed ones grouped by review
// status. Approved and already-delivered documents are called out: approving
// never reruns an approved document by itself, and a delivered one means the
// supplier has the old version.

const ROWS_SHOWN = 100;

export function ImpactTable({ impact }: { impact: ImpactSummary }) {
  const { counts } = impact;
  const changed = impact.rows.filter((r) => r.changed);
  const errors = impact.errors ?? [];

  return (
    <div className="mt-3 space-y-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Styles" value={counts.styles} />
        <Tile label="Documents" value={counts.docs} />
        <Tile label="Change" value={counts.changed} strong />
        <Tile label="Unchanged" value={counts.unchanged} />
      </dl>

      {counts.approvedChanged > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-transparent bg-warn-soft px-3 py-2 text-sm text-warn">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {plural(counts.approvedChanged, "approved document")} change{counts.approvedChanged === 1 ? "s" : ""}. Approving does
            not rerun {counts.approvedChanged === 1 ? "it" : "them"}; after publishing you can send{" "}
            {counts.approvedChanged === 1 ? "it" : "them"} back to review.
          </span>
        </p>
      )}
      {counts.deliveredChanged > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-transparent bg-warn-soft px-3 py-2 text-sm text-warn">
          <Truck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {plural(counts.deliveredChanged, "changed document")} {counts.deliveredChanged === 1 ? "was" : "were"} already
            delivered to the supplier — they have the old version.
          </span>
        </p>
      )}
      {errors.length > 0 && (
        <details className="rounded-md border border-transparent bg-bad-soft px-3 py-2 text-sm text-bad">
          <summary className="cursor-pointer">{plural(errors.length, "style")} could not be compared</summary>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {errors.slice(0, ROWS_SHOWN).map((e) => (
              <li key={e.styleId}>
                <span className="font-mono">{e.styleId}</span>: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {changed.length === 0 ? (
        <p className="text-sm text-muted">No document prints differently with this draft.</p>
      ) : (
        <div className="space-y-2">
          {IMPACT_REVIEW_STATUSES.map((status) => {
            const rows = changed.filter((r) => r.reviewStatus === status);
            if (rows.length === 0) return null;
            return (
              <details key={status} open={status === "PENDING_REVIEW" || status === "APPROVED"} className="rounded-md border border-line">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
                  {REVIEW_STATUS_LABEL[status]} · {count(rows.length)}
                </summary>
                <RowsTable rows={rows} />
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`rounded-md px-3 py-2 ${strong ? "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" : "bg-subtle text-ink"}`}>
      <dt className={`text-[11px] ${strong ? "text-faint" : "text-muted"}`}>{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{count(value)}</dd>
    </div>
  );
}

export function RowsTable({ rows }: { rows: ImpactRow[] }) {
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full text-xs">
        <thead className="bg-subtle text-left text-[11px] text-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">Style</th>
            <th className="px-3 py-1.5 font-medium">PO</th>
            <th className="px-3 py-1.5 font-medium">Document</th>
            <th className="px-3 py-1.5 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, ROWS_SHOWN).map((r) => (
            <tr key={`${r.styleId}|${r.variantKey}`} className="border-t border-line">
              <td className="px-3 py-1.5">
                <a href={`/styles/${r.styleId}`} className="text-ink hover:underline">
                  {r.styleLabel}
                </a>
              </td>
              <td className="px-3 py-1.5 text-muted">{r.poNumber ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-muted">{docSuffix(r.variantKey) ?? "—"}</td>
              <td className="px-3 py-1.5">
                <div className="flex flex-wrap gap-1">
                  {r.inFlight && <Flag tone="blue">run in progress</Flag>}
                  {r.emailed ? <Flag tone="orange">emailed</Flag> : r.uploaded ? <Flag tone="orange">uploaded</Flag> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROWS_SHOWN && (
        <p className="px-3 py-1.5 text-xs text-muted">+{count(rows.length - ROWS_SHOWN)} more</p>
      )}
    </div>
  );
}

function Flag({ tone, children }: { tone: "blue" | "orange"; children: React.ReactNode }) {
  const cls = tone === "blue" ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-orange-50 text-orange-700 ring-orange-200";
  return <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>{children}</span>;
}

import Link from "next/link";
import type { EditKind, OutputSignalRow, SignalTotals } from "@/lib/change-requests/signals";

// Learning signals for the change-request agent (design §5.9): four totals
// and one row per output — how many drafts it took, whether the first one was
// approved, what the reviewer had to ask for, how long it took and what the
// agent cost. Rows come from outputSignals() + signalTotals().
//
// Presentational and server-safe: no hooks, no state, type-only imports from
// signals.ts (so the DB code never reaches a bundle). Mounted on /requests.

const STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  WORKING: "Working",
  IN_REVIEW: "In review",
  NEEDS_INFO: "Needs info",
  NEEDS_CODE: "Needs code",
  APPROVED: "Approved",
  PUBLISHED: "Published",
  REJECTED: "Rejected",
  FAILED: "Failed",
};

const STATUS_STYLE: Record<string, string> = {
  NEW: "bg-zinc-100 text-zinc-600",
  WORKING: "bg-blue-50 text-blue-700",
  IN_REVIEW: "bg-amber-50 text-amber-700",
  NEEDS_INFO: "bg-amber-50 text-amber-700",
  NEEDS_CODE: "bg-violet-50 text-violet-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  PUBLISHED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700",
  FAILED: "bg-red-50 text-red-700",
};

const EDIT_KIND_TITLES: Record<EditKind, string> = {
  size: "Font size changed in a revision",
  position: "A block was moved or resized in a revision",
  wording: "Line text changed in a revision",
  scope: "A block was added or removed in a revision",
  other: "Another property changed in a revision",
};

// ---------- formatting (pure, exported for tests) ----------

export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? `${hours} h ${m} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days} d ${h} h` : `${days} d`;
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function formatRate(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

export function formatDrafts(n: number | null): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------- component ----------

export function SignalsTable({ rows, totals }: { rows: OutputSignalRow[]; totals: SignalTotals }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">How the agent is doing</h2>
        <p className="text-xs text-zinc-500">
          {rows.length
            ? `Latest ${totals.outputs} output${totals.outputs === 1 ? "" : "s"} across ${totals.requests} request${totals.requests === 1 ? "" : "s"}`
            : "No outputs yet"}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-4">
        <Tile label="Requests" value={String(totals.requests)} />
        <Tile label="Approved first try" value={formatRate(totals.firstTryRate)} />
        <Tile label="Median drafts" value={formatDrafts(totals.medianDrafts)} />
        <Tile label="Agent cost" value={formatUsd(totals.totalCostUsd)} />
      </dl>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-zinc-500">
          Numbers appear here once the agent has drafted a change.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[11px] tracking-wide text-zinc-500 uppercase">
                <th className="px-4 py-2 font-semibold">Request</th>
                <th className="px-4 py-2 font-semibold">Output</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Drafts</th>
                <th className="px-4 py-2 font-semibold">First try</th>
                <th className="px-4 py-2 font-semibold">Reviewer asked for</th>
                <th className="px-4 py-2 text-right font-semibold">Time to approval</th>
                <th className="px-4 py-2 text-right font-semibold">Cost</th>
                <th className="px-4 py-2 font-semibold">Reject reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row) => (
                <tr key={row.outputId} className="align-top">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <Link
                      href={`/requests/${row.requestId}`}
                      className="font-mono text-xs text-zinc-700 tabular-nums hover:text-zinc-900 hover:underline"
                    >
                      {row.requestRef}
                    </Link>
                  </td>
                  <td className="max-w-56 px-4 py-2 text-zinc-800">
                    <span className="line-clamp-2">{row.label}</span>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        STATUS_STYLE[row.status] ?? "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {STATUS_LABELS[row.status] ?? row.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-zinc-700 tabular-nums">
                    {row.draftCount}
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    {row.firstTryApproved === true ? (
                      <span className="text-emerald-700">yes</span>
                    ) : row.firstTryApproved === false ? (
                      <span className="text-zinc-600">no</span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {row.editKinds.length ? (
                      <div className="flex flex-wrap gap-1">
                        {row.editKinds.map((kind) => (
                          <span
                            key={kind}
                            title={EDIT_KIND_TITLES[kind]}
                            className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-600"
                          >
                            {kind}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs whitespace-nowrap text-zinc-700 tabular-nums">
                    {formatDuration(row.timeToApprovalMs)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-zinc-700 tabular-nums">
                    {formatUsd(row.costUsd)}
                  </td>
                  <td className="max-w-64 px-4 py-2 text-xs text-zinc-600">
                    {row.rejectReason ? (
                      <span className="line-clamp-2">{row.rejectReason}</span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <dt className="text-[11px] tracking-wide text-zinc-500 uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg font-semibold text-zinc-900 tabular-nums">{value}</dd>
    </div>
  );
}

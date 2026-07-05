import Link from "next/link";
import { formatDate } from "@/lib/utils";
import type { ApprovedStyleRow } from "@/lib/dashboard/approved-styles";

// The done pile — /reviews "Approved" tab. Read-only list, recent-first, with
// a delivery chip per style so approval visibly turns into "in the supplier's
// folder" and "sent" without leaving the board.

const DELIVERY_CHIP: Record<ApprovedStyleRow["delivery"], { label: string; cls: string }> = {
  sent: { label: "sent to supplier", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  uploaded: { label: "in supplier folder", cls: "border-sky-200 bg-sky-50 text-sky-700" },
  queued: { label: "delivery queued", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  none: { label: "no delivery", cls: "border-zinc-200 bg-zinc-50 text-zinc-400" },
};

export function ApprovedList({ styles, total }: { styles: ApprovedStyleRow[]; total: number }) {
  return (
    <div className="mt-3">
      {total > styles.length ? (
        <p className="mb-2 text-xs text-zinc-400">
          Showing the {styles.length} most recent of {total.toLocaleString()} approved styles.
        </p>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Style</th>
              <th className="px-4 py-2">Customer / BA</th>
              <th className="px-4 py-2">Delivery</th>
              <th className="px-4 py-2">Approved</th>
            </tr>
          </thead>
          <tbody>
            {styles.map((s) => {
              const chip = DELIVERY_CHIP[s.delivery];
              return (
                <tr key={s.styleId} className="border-t border-zinc-100">
                  <td className="px-4 py-2">
                    <Link href={`/styles/${s.styleId}`} className="font-medium text-zinc-800 underline">
                      {s.name}
                    </Link>
                    {s.poNumber ? (
                      <div className="font-mono text-[11px] text-zinc-400">{s.poNumber}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-zinc-600">
                    {s.customer}
                    {s.businessArea ? <span className="text-zinc-400"> · {s.businessArea}</span> : null}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}
                    >
                      {chip.label}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">{formatDate(s.approvedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  READY: "bg-emerald-100 text-emerald-800",
  GENERATING: "bg-blue-100 text-blue-800",
  AWAITING_REVIEW: "bg-purple-100 text-purple-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
};

export default async function StylesPage() {
  // Archived / deleted Monday items are retained for the audit log but hidden here.
  const styles = await db.style.findMany({
    where: { archivedAt: null, deletedAt: null },
    include: { customer: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Styles</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {styles.length} {styles.length === 1 ? "style" : "styles"} synced from Monday.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Style</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Business area</th>
              <th className="px-4 py-3">Completion</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last synced</th>
            </tr>
          </thead>
          <tbody>
            {styles.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                  No styles synced yet. Trigger a Monday webhook event to populate.
                </td>
              </tr>
            ) : (
              styles.map((s) => (
                <tr key={s.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/styles/${s.id}`} className="hover:underline">{s.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{s.customer.name}</td>
                  <td className="px-4 py-3 text-zinc-600">{s.businessArea ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-zinc-100">
                        <div
                          className="h-full bg-zinc-900"
                          style={{ width: `${s.completionPct}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-zinc-600">{s.completionPct}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[s.status] ?? "bg-zinc-100 text-zinc-700"
                      }`}
                    >
                      {s.status.toLowerCase().replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{formatDate(s.lastSyncedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const customers = await db.customer.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { styles: true, prodSpecs: true } } },
  });

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Mirrored from Monday board <code className="font-mono">3317892788</code>. Sync from{" "}
            <Link href="/sync" className="underline">Sync</Link> or via webhook.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Country</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Sales</th>
              <th className="px-4 py-3">Styles</th>
              <th className="px-4 py-3">Prod specs</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Synced</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-zinc-500">
                  No customers yet. Run the Customer sync from{" "}
                  <Link href="/sync" className="underline">/sync</Link>.
                </td>
              </tr>
            ) : (
              customers.map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-zinc-100 hover:bg-zinc-50 ${c.active ? "" : "opacity-50"}`}
                >
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/customers/${c.id}`} className="hover:underline">{c.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{c.country ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">{c.priority ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">{c.salesResponsible ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{c._count.styles}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{c._count.prodSpecs}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500 font-mono">
                    {c.mondayItemId ? c.mondayItemId : "manual"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(c.lastSyncedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/customers/${c.id}`} className="text-xs text-zinc-700 underline">
                      Configure
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

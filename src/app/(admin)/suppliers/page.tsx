import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { ResyncSupplierButton } from "./resync-button";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const suppliers = await db.supplier.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { styles: true, prodSpecSuppliers: true } } },
  });

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Mirrored from Monday board <code className="font-mono">3363275451</code>. Read-only;
          edit in Monday and Re-sync to pull updates here.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Purchaser</th>
              <th className="px-4 py-3">Country</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Folder</th>
              <th className="px-4 py-3">Styles</th>
              <th className="px-4 py-3">In specs</th>
              <th className="px-4 py-3">Synced</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-zinc-500">
                  No suppliers yet. Run the Supplier sync from <a href="/sync" className="underline">/sync</a>.
                </td>
              </tr>
            ) : (
              suppliers.map((s) => (
                <tr
                  key={s.id}
                  className={`border-t border-zinc-100 ${s.active ? "" : "opacity-50"}`}
                >
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 text-zinc-600">{s.purchaser ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">{s.country ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">{s.location ?? "—"}</td>
                  <td className="px-4 py-3 text-xs">
                    {s.sharepointUrl ? (
                      <a
                        href={s.sharepointUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-700 underline"
                      >
                        open
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{s._count.styles}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{s._count.prodSpecSuppliers}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(s.lastSyncedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <ResyncSupplierButton supplierId={s.id} />
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

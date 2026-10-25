import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { parseCustomerConfig } from "@/lib/customers/config";
import { SkipSupplierDeliveryBadge } from "@/components/skip-supplier-delivery-badge";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Customers" };

export default async function CustomersPage() {
  await requireAdminPage();

  const customers = await db.customer.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { styles: true, prodSpecs: true } } },
  });

  return (
    <div className="px-6 py-5">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Customers</h1>
          <p className="mt-1 text-sm text-muted">
            Mirrored from Monday board <code className="font-mono">3317892788</code>. Sync from{" "}
            <Link href="/sync" className="underline">Sync</Link> or via webhook.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Country</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Sales</th>
              <th className="px-3 py-2">Styles</th>
              <th className="px-3 py-2">Prod specs</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Synced</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-muted">
                  No customers yet. Run the Customer sync from{" "}
                  <Link href="/sync" className="underline">/sync</Link>.
                </td>
              </tr>
            ) : (
              customers.map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-line hover:bg-subtle ${c.active ? "" : "opacity-50"}`}
                >
                  <td className="px-3 py-2 font-medium">
                    <span className="flex items-center gap-1.5">
                      <Link href={`/customers/${c.id}`} className="hover:underline">{c.name}</Link>
                      {parseCustomerConfig(c.config).skipSupplierDelivery && (
                        <SkipSupplierDeliveryBadge variant="chip" />
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted">{c.country ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{c.priority ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{c.salesResponsible ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{c._count.styles}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{c._count.prodSpecs}</td>
                  <td className="px-3 py-2 text-xs text-muted font-mono">
                    {c.mondayItemId ? c.mondayItemId : "manual"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{formatDate(c.lastSyncedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/customers/${c.id}`} className="text-xs text-ink underline">
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

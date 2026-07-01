import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/auth-server";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";
import { SupplierSendSetting } from "./supplier-send-setting";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approved & delivery" };

// WS2a — the delivery control tower. Shows the supplier-send queue: every
// approved output waiting to reach its supplier, grouped by supplier (with the
// resolved email) and listed in detail. Sending is gated by the master toggle
// at the top; while it's off this is a pure preview of what WOULD go out.
// The sent log + Resend open-tracking land with WS2b.
export default async function ApprovedDeliveryPage() {
  await requireAdminPage();

  const [enabled, pending] = await Promise.all([
    getSupplierBatchSendEnabled(),
    db.supplierSendQueueItem.findMany({
      where: { sentAt: null },
      orderBy: { queuedAt: "desc" },
      take: 500,
    }),
  ]);

  // Resolve the loose refs (styleId / customerId / supplierId) in bulk.
  const styleIds = [...new Set(pending.map((p) => p.styleId))];
  const customerIds = [...new Set(pending.map((p) => p.customerId))];
  const supplierIds = [...new Set(pending.map((p) => p.supplierId).filter((x): x is string => !!x))];

  const [styles, customers, suppliers] = await Promise.all([
    db.style.findMany({
      where: { id: { in: styleIds } },
      select: {
        id: true,
        name: true,
        poNumber: true,
        businessArea: true,
        businessAreaRef: { select: { name: true } },
      },
    }),
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
    db.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true, email: true, contactEmail: true },
    }),
  ]);

  const styleById = new Map(styles.map((s) => [s.id, s]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const resolveEmail = (supplierId: string | null): string | null => {
    if (!supplierId) return null;
    const s = supplierById.get(supplierId);
    return s?.email?.trim() || s?.contactEmail?.trim() || null;
  };

  // Group by supplier for the summary.
  type Group = { supplierId: string | null; name: string; email: string | null; count: number };
  const groups = new Map<string, Group>();
  for (const item of pending) {
    const key = item.supplierId ?? "__none__";
    const g = groups.get(key);
    if (g) g.count += 1;
    else
      groups.set(key, {
        supplierId: item.supplierId,
        name: item.supplierId ? (supplierById.get(item.supplierId)?.name ?? "Unknown supplier") : "— no supplier linked",
        email: resolveEmail(item.supplierId),
        count: 1,
      });
  }
  const groupList = [...groups.values()].sort((a, b) => b.count - a.count);

  const spPill = (status: string) => {
    const map: Record<string, string> = {
      UPLOADED: "border-emerald-200 bg-emerald-50 text-emerald-700",
      PENDING: "border-amber-200 bg-amber-50 text-amber-700",
      FAILED: "border-red-200 bg-red-50 text-red-700",
      SKIPPED: "border-zinc-200 bg-zinc-50 text-zinc-500",
    };
    return map[status] ?? map.PENDING;
  };

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Approved &amp; delivery</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Approved outputs waiting to reach their supplier. {pending.length} output
        {pending.length === 1 ? "" : "s"} queued across {groupList.length} supplier
        {groupList.length === 1 ? "" : "s"}.
      </p>

      <div className="mt-6 max-w-3xl">
        <SupplierSendSetting initialEnabled={enabled} />
      </div>

      {/* Per-supplier summary — who gets what tonight, and to which email. */}
      <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-700">By supplier</h2>
      <div className="overflow-hidden rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Outputs queued</th>
            </tr>
          </thead>
          <tbody>
            {groupList.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                  Nothing queued yet. Outputs appear here as soon as they&rsquo;re approved.
                </td>
              </tr>
            ) : (
              groupList.map((g) => (
                <tr key={g.supplierId ?? "none"} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-medium text-zinc-800">{g.name}</td>
                  <td className="px-4 py-2">
                    {g.email ? (
                      <span className="font-mono text-xs text-zinc-600">{g.email}</span>
                    ) : (
                      <span className="inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                        no email on file
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-zinc-700">{g.count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Detail — every queued output. */}
      <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-700">Queued outputs</h2>
      <div className="overflow-hidden rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Customer / BA</th>
              <th className="px-4 py-2">Style</th>
              <th className="px-4 py-2">Output</th>
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">SharePoint</th>
              <th className="px-4 py-2">Queued</th>
            </tr>
          </thead>
          <tbody>
            {pending.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                  No approved outputs are waiting.
                </td>
              </tr>
            ) : (
              pending.map((item) => {
                const style = styleById.get(item.styleId);
                const customer = customerById.get(item.customerId);
                const ba = style?.businessAreaRef?.name ?? style?.businessArea ?? "—";
                return (
                  <tr key={item.id} className="border-t border-zinc-100">
                    <td className="px-4 py-2">
                      <div className="font-medium text-zinc-800">{customer?.name ?? "—"}</div>
                      <div className="text-xs text-zinc-500">{ba}</div>
                    </td>
                    <td className="px-4 py-2">
                      <Link href={`/styles/${item.styleId}`} className="text-zinc-700 underline">
                        {style?.name ?? item.styleId}
                      </Link>
                      {style?.poNumber ? (
                        <div className="font-mono text-[11px] text-zinc-400">{style.poNumber}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-zinc-700">{item.displayName ?? item.docType}</div>
                      <div className="font-mono text-[11px] text-zinc-400">{item.variantKey}</div>
                    </td>
                    <td className="px-4 py-2 text-zinc-600">
                      {item.supplierId ? supplierById.get(item.supplierId)?.name ?? "—" : (
                        <span className="text-red-500">none</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${spPill(item.sharePointStatus)}`}
                      >
                        {item.sharePointStatus.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {item.queuedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-2xl text-xs text-zinc-400">
        The nightly send, the sent-email log, and supplier open-tracking (Resend) arrive with the
        next delivery PR. Missing supplier emails resolve once the Monday supplier sync is updated.
      </p>
    </div>
  );
}

import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { ResyncSupplierButton } from "./resync-button";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Suppliers" };

export default async function SuppliersPage() {
  await requireAdminPage();

  const suppliers = await db.supplier.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { styles: true, prodSpecSuppliers: true } } },
  });

  // Synced contact people (Supplier Contacts board 3363269178), grouped per
  // supplier. Additive table — degrade to "no contacts" until db:deploy has
  // run rather than 500ing the page.
  const contactsBySupplier = new Map<
    string,
    Array<{ name: string; email: string | null; contactType: string | null; status: string | null }>
  >();
  try {
    const contacts = await db.supplierContact.findMany({
      where: { active: true, supplierId: { not: null } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: { supplierId: true, name: true, email: true, contactType: true, status: true },
    });
    for (const c of contacts) {
      const arr = contactsBySupplier.get(c.supplierId!) ?? [];
      arr.push(c);
      contactsBySupplier.set(c.supplierId!, arr);
    }
  } catch {
    // table not migrated yet
  }

  return (
    <div className="px-6 py-5">
      <div className="mb-6">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Suppliers</h1>
        <p className="mt-1 text-sm text-muted">
          Mirrored from Monday board <code className="font-mono">3363275451</code>. Read-only;
          edit in Monday and Re-sync to pull updates here.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Purchaser</th>
              <th className="px-3 py-2">Email / contact</th>
              <th className="px-3 py-2">Contacts</th>
              <th className="px-3 py-2">Country</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2">Folder</th>
              <th className="px-3 py-2">Styles</th>
              <th className="px-3 py-2">In specs</th>
              <th className="px-3 py-2">Synced</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-muted">
                  No suppliers yet. Run the Supplier sync from <a href="/sync" className="underline">/sync</a>.
                </td>
              </tr>
            ) : (
              suppliers.map((s) => (
                <tr
                  key={s.id}
                  className={`border-t border-line ${s.active ? "" : "opacity-50"}`}
                >
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2 text-muted">{s.purchaser ?? "—"}</td>
                  <td data-private className="px-3 py-2 text-xs text-muted">
                    {s.email ? <div>{s.email}</div> : <span className="text-faint">—</span>}
                    {s.contactEmail && (
                      <div className="text-faint">
                        cc {s.contactName ? `${s.contactName} · ` : ""}
                        {s.contactEmail}
                      </div>
                    )}
                  </td>
                  <td data-private className="px-3 py-2 text-xs text-muted">
                    {(contactsBySupplier.get(s.id) ?? []).length === 0 ? (
                      <span className="text-faint">—</span>
                    ) : (
                      (contactsBySupplier.get(s.id) ?? []).map((c, i) => (
                        <div
                          key={i}
                          className={c.status === "Active" ? "" : "text-faint line-through"}
                          title={`${c.contactType ?? "—"} · ${c.status ?? "—"}`}
                        >
                          {c.name}
                          {c.email ? ` · ${c.email}` : ""}
                        </div>
                      ))
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">{s.country ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{s.location ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.sharepointUrl ? (
                      <a
                        href={s.sharepointUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ink underline"
                      >
                        open
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">{s._count.styles}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{s._count.prodSpecSuppliers}</td>
                  <td className="px-3 py-2 text-xs text-muted">{formatDate(s.lastSyncedAt)}</td>
                  <td className="px-3 py-2 text-right">
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

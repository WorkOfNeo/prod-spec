import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { requireAdminPage } from "@/lib/auth-server";
import { ComboRowActions, RescanCombosButton } from "./combo-row-actions";

export const dynamic = "force-dynamic";

// Customer × Business-Area combo registry. Lists every combo present among
// active styles (same set as /styles), NEW first. A newcomer is flagged NEW
// and stages a heads-up email to nh@neo-labs.com; the admin gives it a first
// look, builds the ProdSpec / PDFs, then marks it reviewed. See
// src/lib/combos/reconcile.ts for how the registry is kept up to date.
export default async function CombosPage() {
  await requireAdminPage();

  const [combos, specPairs] = await Promise.all([
    db.customerBusinessAreaCombo.findMany({
      orderBy: [
        { status: "asc" }, // NEW before REVIEWED (Postgres enum declaration order)
        { activeStyleCount: "desc" },
        { firstSeenAt: "desc" },
      ],
    }),
    // Existing ProdSpecs keyed by their (customer, business area) pair — a
    // combo with a match shows "Open spec" instead of "Create", so we never
    // attempt a duplicate (the pair is unique) or rename an existing one.
    db.prodSpec.findMany({ select: { id: true, customerId: true, businessAreaId: true } }),
  ]);
  const specByPair = new Map(specPairs.map((s) => [`${s.customerId}:${s.businessAreaId}`, s.id]));

  const newCount = combos.filter((c) => c.status === "NEW").length;
  const activeCount = combos.filter((c) => c.activeStyleCount > 0).length;

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New combos</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Customer × business-area combinations present among active styles (the same set as{" "}
            <Link href="/styles" className="underline">
              Styles
            </Link>
            ). A new combination is flagged <strong>New</strong> and stages an email to
            nh@neo-labs.com so it gets a first look before PDFs are made.{" "}
            <span className="tabular-nums">
              {newCount} new · {activeCount} active.
            </span>
          </p>
        </div>
        <RescanCombosButton />
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Business area</th>
              <th className="px-4 py-3">Active styles</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">First seen</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {combos.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                  No combos yet. Run a style sync from{" "}
                  <Link href="/sync" className="underline">
                    /sync
                  </Link>{" "}
                  or press “Rescan now”.
                </td>
              </tr>
            ) : (
              combos.map((c) => {
                const inactive = c.activeStyleCount === 0;
                return (
                  <tr
                    key={c.id}
                    className={`border-t border-zinc-100 hover:bg-zinc-50 ${inactive ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/customers/${c.customerId}`} className="hover:underline">
                        {c.customerName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-zinc-600">{c.baLabel}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-600">{c.activeStyleCount}</td>
                    <td className="px-4 py-3">
                      <StatusPill status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(c.firstSeenAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <ComboRowActions
                        id={c.id}
                        status={c.status}
                        hasBusinessArea={c.businessAreaId !== null}
                        existingSpecId={
                          c.businessAreaId
                            ? specByPair.get(`${c.customerId}:${c.businessAreaId}`) ?? null
                            : null
                        }
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "NEW" | "REVIEWED" }) {
  if (status === "NEW") {
    return (
      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        New
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
      Reviewed
    </span>
  );
}

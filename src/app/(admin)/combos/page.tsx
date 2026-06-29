import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { requireAdminPage } from "@/lib/auth-server";
import { ComboRowActions, RescanCombosButton } from "./combo-row-actions";

export const dynamic = "force-dynamic";

// Enabled-output count on a ProdSpec's `outputs` JSON. Defensive: a malformed
// row counts as zero rather than throwing the whole page.
function enabledOutputCount(outputs: unknown): number {
  try {
    return parseProdSpecOutputs(outputs).filter((o) => o.enabled !== false).length;
  } catch {
    return 0;
  }
}

// Customer × Business-Area combo registry. Lists every combo present among
// active styles (the same set as /styles). Each combo's status is DERIVED from
// its auto-created ProdSpec: a combo stays New until that spec is active AND
// carries at least one enabled output, then it's Ready — there's no manual
// review flag. A newly-detected combo still stages a heads-up email (see
// src/lib/combos/reconcile.ts; that alert is gated on notifiedAt, not status).
export const metadata = { title: "New combos" };

export default async function CombosPage() {
  await requireAdminPage();

  const [combos, specPairs] = await Promise.all([
    db.customerBusinessAreaCombo.findMany({
      orderBy: [{ activeStyleCount: "desc" }, { firstSeenAt: "desc" }],
    }),
    // ProdSpecs keyed by their (customer, business area) pair — drives both the
    // derived status (active + enabled outputs) and the Open/Create action.
    db.prodSpec.findMany({
      select: { id: true, customerId: true, businessAreaId: true, active: true, outputs: true },
    }),
  ]);
  const specByPair = new Map(
    specPairs.map((s) => [
      `${s.customerId}:${s.businessAreaId}`,
      { id: s.id, active: s.active, enabledOutputs: enabledOutputCount(s.outputs) },
    ]),
  );

  // Ready = the combo's ProdSpec is active AND has >=1 enabled output;
  // otherwise New (no spec — e.g. a combo with no business area — no outputs
  // yet, or the spec was deactivated).
  const rows = combos
    .map((c) => {
      const spec = c.businessAreaId ? specByPair.get(`${c.customerId}:${c.businessAreaId}`) ?? null : null;
      const status: "NEW" | "READY" = spec && spec.active && spec.enabledOutputs > 0 ? "READY" : "NEW";
      return { combo: c, specId: spec?.id ?? null, status };
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "NEW" ? -1 : 1; // New first
      if (b.combo.activeStyleCount !== a.combo.activeStyleCount) {
        return b.combo.activeStyleCount - a.combo.activeStyleCount;
      }
      return b.combo.firstSeenAt.getTime() - a.combo.firstSeenAt.getTime();
    });

  const newCount = rows.filter((r) => r.status === "NEW").length;
  const readyCount = rows.length - newCount;

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
            ). A combo is <strong>New</strong> until its Prod Spec is active with outputs attached, then it&apos;s{" "}
            <strong>Ready</strong>. New combinations also stage a heads-up email to nh@neo-labs.com.{" "}
            <span className="tabular-nums">
              {newCount} new · {readyCount} ready.
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
            {rows.length === 0 ? (
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
              rows.map(({ combo: c, specId, status }) => {
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
                      <StatusPill status={status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(c.firstSeenAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <ComboRowActions id={c.id} hasBusinessArea={c.businessAreaId !== null} existingSpecId={specId} />
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

function StatusPill({ status }: { status: "NEW" | "READY" }) {
  if (status === "READY") {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        Ready
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      New
    </span>
  );
}

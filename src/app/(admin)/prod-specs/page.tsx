import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { getVariant } from "@/lib/pdf/template-registry";
import { NewProdSpecButton } from "./new-prod-spec-button";
import { ProdSpecsTable } from "./prod-specs-table";

// Resolve a ProdSpec.outputs JSON blob into display chips for the list.
// Defensive: malformed JSON yields [] rather than crashing the whole page.
function summariseOutputs(raw: unknown): Array<{ key: string; name: string; enabled: boolean }> {
  try {
    return parseProdSpecOutputs(raw).map((o) => ({
      key: o.variantKey,
      name: getVariant(o.variantKey)?.name ?? o.variantKey,
      enabled: o.enabled !== false,
    }));
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function ProdSpecsPage() {
  const [prodSpecs, customers, businessAreas, existingPairs] = await Promise.all([
    db.prodSpec.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        customer: true,
        businessArea: true,
        _count: { select: { suppliers: true, styles: true, jobs: true } },
      },
    }),
    db.customer.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.businessArea.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, mondayValue: true, name: true },
    }),
    // Already-linked (Customer, BA) pairs — the dialog uses this to grey
    // out / hide the combos that would conflict on submit, so users can
    // only create *fitting* combinations.
    db.prodSpec.findMany({
      select: { customerId: true, businessAreaId: true },
    }),
  ]);

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Prod specs</h1>
          <p className="mt-1 text-sm text-zinc-500">
            One per (Customer × Business area). Auto-create on Style ingest, click <strong>+ New</strong>{" "}
            for a one-off, or use <strong>Suggestions</strong> to step through pairs the ghost data already
            hints at. Tune outputs, suppliers, and the threshold from each row.
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Link
            href="/prod-specs/languages"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Languages
          </Link>
          <Link
            href="/prod-specs/suggestions"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Suggestions
          </Link>
          <NewProdSpecButton
            customers={customers}
            businessAreas={businessAreas}
            existingPairs={existingPairs}
          />
        </div>
      </div>

      <ProdSpecsTable
        rows={prodSpecs.map((ps) => {
          const outputs = summariseOutputs(ps.outputs);
          return {
            id: ps.id,
            name: ps.name,
            customerName: ps.customer.name,
            businessAreaName: ps.businessArea.name,
            businessAreaMondayValue: ps.businessArea.mondayValue,
            outputs,
            supplierCount: ps._count.suppliers,
            styleCount: ps._count.styles,
            jobCount: ps._count.jobs,
            autoGenerateThresholdPct: ps.autoGenerateThresholdPct,
            active: ps.active,
            updatedAt: formatDate(ps.updatedAt),
            // Pre-built lower-case search blob — keeps the client-side
            // filter a single string check regardless of which field
            // matches. Includes mondayValue so "PL" hits both alias and
            // canonical rows, and the output names so a search for
            // "care label" finds every spec that produces one.
            searchBlob: [
              ps.name,
              ps.customer.name,
              ps.businessArea.name,
              ps.businessArea.mondayValue,
              ...outputs.map((o) => o.name),
            ]
              .join(" ")
              .toLowerCase(),
          };
        })}
      />
    </div>
  );
}

import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { buttonClass } from "@/components/ui/button";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getVariant } from "@/lib/pdf/template-registry";
import { NewProdSpecButton } from "./new-prod-spec-button";
import { ProdSpecsTable } from "./prod-specs-table";
import { requireAdminPage } from "@/lib/auth-server";

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

export const metadata = { title: "Prod specs" };

export default async function ProdSpecsPage() {
  await requireAdminPage();

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
    <div className="px-6 py-5">
      <PageHeader
        title="Prod specs"
        meta="One per customer and business area. Created on style ingest; New makes a one-off, Suggestions steps through pairs the ghost data hints at."
        actions={
          <>
            <Link href="/prod-specs/languages" className={buttonClass("ghost")}>
              Languages
            </Link>
            <Link href="/prod-specs/suggestions" className={buttonClass("secondary")}>
              Suggestions
            </Link>
            <NewProdSpecButton customers={customers} businessAreas={businessAreas} existingPairs={existingPairs} />
          </>
        }
        className="mb-5"
      />

      <ProdSpecsTable
        rows={prodSpecs.map((ps) => {
          const outputs = summariseOutputs(ps.outputs);
          return {
            id: ps.id,
            name: ps.name,
            customerName: ps.customer.name,
            // Customer delivers their own goods — chip beside the customer so
            // this spec's outputs aren't assumed to ship a supplier delivery.
            customerDeliversOwn: parseCustomerConfig(ps.customer.config).skipSupplierDelivery,
            businessAreaName: ps.businessArea.name,
            businessAreaMondayValue: ps.businessArea.mondayValue,
            // Non-empty General information markdown ⇒ the spec emits a
            // general-info page; drives the "General info" presence filter.
            hasGeneralInfo: Boolean(ps.generalInfoMd && ps.generalInfoMd.trim()),
            outputs,
            supplierCount: ps._count.suppliers,
            styleCount: ps._count.styles,
            jobCount: ps._count.jobs,
            autoGenerateThresholdPct: ps.autoGenerateThresholdPct,
            active: ps.active,
            fullyApproved: ps.fullyApproved,
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

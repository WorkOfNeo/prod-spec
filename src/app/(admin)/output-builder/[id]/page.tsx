import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { listActiveLanguages } from "@/lib/languages/active";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { LAYOUT_VARIANT_PREFIX } from "@/lib/output-layouts/variants";
import { generationStatsForLayout } from "@/lib/output-layouts/stats";
import { loadDocTypes } from "@/lib/pdf/doc-types-db";
import { EXCLUSION_FIELDS } from "@/lib/outputs/exclusion";
import { LayoutEditor } from "./layout-editor";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const layout = await db.outputLayout.findUnique({ where: { id }, select: { name: true } });
  return { title: layout ? `${layout.name} · Output builder` : "Output builder" };
}

export default async function OutputLayoutEditorPage(props: { params: Promise<{ id: string }> }) {
  await requireAdminPage();

  const { role } = await getSessionWithRole();
  if (role !== "ADMIN") {
    return (
      <div className="px-8 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Output builder</h1>
        <p className="mt-3 text-sm text-zinc-500">The Output Builder is admin-only.</p>
      </div>
    );
  }

  const { id } = await props.params;
  const [layout, customers, businessAreas, languages, stats, recentAssetRows, specs] = await Promise.all([
    db.outputLayout.findUnique({ where: { id } }),
    db.customer.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.businessArea.findMany({
      where: { active: true, mergedIntoId: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    listActiveLanguages(),
    generationStatsForLayout(id),
    // Recent generated assets for the Reviews tab — this layout's variant key
    // and its per-EAN `#suffix` siblings, newest first.
    db.jobAsset.findMany({
      where: {
        OR: [
          { variantKey: `${LAYOUT_VARIANT_PREFIX}${id}` },
          { variantKey: { startsWith: `${LAYOUT_VARIANT_PREFIX}${id}#` } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        displayName: true,
        fileName: true,
        reviewStatus: true,
        placeholderCount: true,
        createdAt: true,
        jobId: true,
        job: { select: { styleId: true, style: { select: { name: true } } } },
      },
    }),
    db.prodSpec.findMany({
      select: { id: true, name: true, outputs: true, customer: { select: { name: true } } },
    }),
  ]);
  if (!layout) notFound();

  // Prod Specs that reference this layout as an output (layout:<id>, enabled
  // or not) — shown in the editor's delete confirmation. Matched in JS because
  // `outputs` is JSON, not relational. Parse defensively so one bad spec can't
  // 500 the editor.
  const layoutKey = `${LAYOUT_VARIANT_PREFIX}${id}`;
  const prodSpecs = specs
    .filter((s) => {
      try {
        return parseProdSpecOutputs(s.outputs).some((o) => o.variantKey === layoutKey);
      } catch {
        return false;
      }
    })
    .map((s) => ({ id: s.id, name: s.name, customerName: s.customer.name }));

  const recentAssets = recentAssetRows.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    fileName: a.fileName,
    reviewStatus: a.reviewStatus,
    placeholderCount: a.placeholderCount,
    createdAt: a.createdAt.toISOString(),
    jobId: a.jobId,
    styleId: a.job.styleId,
    styleName: a.job.style.name,
  }));

  let definition;
  try {
    definition = parseLayoutDef(layout.definition);
  } catch {
    definition = parseLayoutDef({});
  }

  return (
    <LayoutEditor
      layout={{
        id: layout.id,
        name: layout.name,
        docType: layout.docType,
        status: layout.status,
        version: layout.version,
        autoApprove: layout.autoApprove,
        isInfoArea: layout.isInfoArea,
        customLogo: layout.customLogo,
        customerId: layout.customerId,
        businessAreaId: layout.businessAreaId,
        definition,
      }}
      customers={customers}
      docTypes={await loadDocTypes()}
      businessAreas={businessAreas}
      languages={languages}
      stats={stats}
      recentAssets={recentAssets}
      prodSpecs={prodSpecs}
      // Fields the Settings tab's generation rules can gate on — same list the
      // Document types popup uses, so both rule scopes offer the same choices.
      ruleFields={[...EXCLUSION_FIELDS]}
    />
  );
}

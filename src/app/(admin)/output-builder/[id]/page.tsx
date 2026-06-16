import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { listActiveLanguages } from "@/lib/languages/active";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { LAYOUT_VARIANT_PREFIX } from "@/lib/output-layouts/variants";
import { generationStatsForLayout } from "@/lib/output-layouts/stats";
import { loadDocTypes } from "@/lib/pdf/doc-types-db";
import { LayoutEditor } from "./layout-editor";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

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
  const [layout, customers, businessAreas, languages, stats, recentAssetRows] = await Promise.all([
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
  ]);
  if (!layout) notFound();

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
    />
  );
}

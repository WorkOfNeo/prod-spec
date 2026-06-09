import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { BusinessAreaList } from "./business-area-list";

export const dynamic = "force-dynamic";

export default async function BusinessAreasPage() {
  const areas = await db.businessArea.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { styles: true, prodSpecs: true } },
      mergedInto: { select: { id: true, name: true, mondayValue: true } },
    },
  });

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Business areas</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Mirrored from the Business Area dropdown on the Styles board, or created manually for new
          areas Monday doesn&apos;t carry yet. <code className="font-mono">mondayValue</code> is the
          string ingest matches against; <code className="font-mono">name</code> is the editable
          display. Use the <strong>Merge</strong> action to alias duplicates (e.g. PL → Private
          Label).
        </p>
      </div>

      <BusinessAreaList
        initialAreas={areas.map((a) => ({
          id: a.id,
          mondayValue: a.mondayValue,
          name: a.name,
          active: a.active,
          styleCount: a._count.styles,
          prodSpecCount: a._count.prodSpecs,
          lastSyncedAt: formatDate(a.lastSyncedAt),
          mergedInto: a.mergedInto
            ? {
                id: a.mergedInto.id,
                name: a.mergedInto.name,
                mondayValue: a.mergedInto.mondayValue,
              }
            : null,
        }))}
      />
    </div>
  );
}

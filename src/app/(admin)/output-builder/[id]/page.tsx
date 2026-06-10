import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { listActiveLanguages } from "@/lib/languages/active";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { LayoutEditor } from "./layout-editor";

export const dynamic = "force-dynamic";

export default async function OutputLayoutEditorPage(props: { params: Promise<{ id: string }> }) {
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
  const [layout, customers, businessAreas, languages] = await Promise.all([
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
  ]);
  if (!layout) notFound();

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
        customerId: layout.customerId,
        businessAreaId: layout.businessAreaId,
        definition,
      }}
      customers={customers}
      businessAreas={businessAreas}
      languages={languages}
    />
  );
}

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { listActiveLanguages } from "@/lib/languages/active";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { LAYOUT_VARIANT_PREFIX } from "@/lib/output-layouts/variants";
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
  const [layout, customers, businessAreas, languages, specs] = await Promise.all([
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
    db.prodSpec.findMany({
      select: { id: true, name: true, outputs: true, customer: { select: { name: true } } },
    }),
  ]);
  if (!layout) notFound();

  // Prod Specs that reference this layout as an output (layout:<id>, enabled
  // or not) — surfaced in the editor's delete confirmation. Matched in JS
  // because `outputs` is JSON, not relational (same join the list page does).
  // A single malformed spec must not 500 the editor, so parse defensively.
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
        isInfoArea: layout.isInfoArea,
        customerId: layout.customerId,
        businessAreaId: layout.businessAreaId,
        definition,
      }}
      customers={customers}
      docTypes={await loadDocTypes()}
      businessAreas={businessAreas}
      languages={languages}
      prodSpecs={prodSpecs}
    />
  );
}

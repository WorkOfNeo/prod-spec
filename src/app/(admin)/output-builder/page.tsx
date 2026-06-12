import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { LAYOUT_VARIANT_PREFIX } from "@/lib/output-layouts/variants";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { getContrastLogoDataUrl } from "@/lib/output-layouts/logos";
import { LayoutsList } from "./layouts-list";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

// Output Builder — list of operator-built layouts. Admin-only: the
// builder writes print-affecting config.
export default async function OutputBuilderPage() {
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

  const contrastLogo = await getContrastLogoDataUrl();
  // {{logo:custom}} is per style now — the card links to the LogoImage
  // library instead of hosting a global upload. Count defensively: the
  // logo_images migration may not be applied yet.
  let logoImageCount = 0;
  try {
    logoImageCount = await db.logoImage.count({ where: { active: true } });
  } catch {
    // table missing — card shows 0 and the library page explains itself
  }

  let rows;
  try {
    rows = await db.outputLayout.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        customer: { select: { name: true } },
        businessArea: { select: { name: true } },
      },
    });
  } catch {
    // output_layouts table not reachable — almost always "migration not
    // applied yet". Render the actionable state instead of a 500.
    return (
      <div className="px-8 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Output builder</h1>
        <div className="mt-6 max-w-xl rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-medium text-amber-800">Database migration pending</p>
          <p className="mt-1 text-sm text-amber-700">
            The <code className="font-mono text-xs">output_layouts</code> table doesn&apos;t exist yet. Apply the
            pending migration, then reload:
          </p>
          <pre className="mt-2 rounded bg-white px-3 py-2 font-mono text-xs text-zinc-700">npm run db:deploy</pre>
        </div>
      </div>
    );
  }

  // Usage joins for the list: which Prod Specs carry each layout as an
  // ENABLED output (matched on the "layout:<id>" variant key inside the
  // outputs JSON — not relational, so joined in JS), the customer each
  // spec belongs to, and the styles currently resolved to those specs.
  // Style lists are capped per layout — the popover shows the first
  // STYLE_CAP plus a "+N more" tail, the count is always exact.
  const STYLE_CAP = 30;
  const specs = await db.prodSpec.findMany({
    select: { id: true, name: true, outputs: true, customer: { select: { name: true } } },
  });
  const specsByLayout = new Map<string, Array<{ id: string; name: string; customerName: string }>>();
  for (const s of specs) {
    for (const o of parseProdSpecOutputs(s.outputs)) {
      if (o.enabled === false || !o.variantKey.startsWith(LAYOUT_VARIANT_PREFIX)) continue;
      const layoutId = o.variantKey.slice(LAYOUT_VARIANT_PREFIX.length);
      const list = specsByLayout.get(layoutId) ?? [];
      if (!list.some((x) => x.id === s.id)) {
        list.push({ id: s.id, name: s.name, customerName: s.customer.name });
      }
      specsByLayout.set(layoutId, list);
    }
  }
  const usedSpecIds = [...new Set([...specsByLayout.values()].flat().map((s) => s.id))];
  const usageStyles = usedSpecIds.length
    ? await db.style.findMany({
        where: { prodSpecId: { in: usedSpecIds } },
        select: { id: true, name: true, prodSpecId: true },
        orderBy: { updatedAt: "desc" },
      })
    : [];
  const stylesBySpec = new Map<string, Array<{ id: string; name: string }>>();
  for (const st of usageStyles) {
    if (!st.prodSpecId) continue;
    const list = stylesBySpec.get(st.prodSpecId) ?? [];
    list.push({ id: st.id, name: st.name });
    stylesBySpec.set(st.prodSpecId, list);
  }

  const layouts = rows.map((l) => {
    let pageCount = 0;
    let defInvalid = false;
    try {
      pageCount = parseLayoutDef(l.definition).pages.length;
    } catch {
      // invalid definition — editable, but show as such
      defInvalid = true;
    }
    const usedBy = specsByLayout.get(l.id) ?? [];
    // A style belongs to exactly one ProdSpec, so the union across this
    // layout's specs is duplicate-free by construction.
    const styles = usedBy.flatMap((s) => stylesBySpec.get(s.id) ?? []);
    return {
      id: l.id,
      name: l.name,
      docType: l.docType,
      status: l.status,
      version: l.version,
      pageCount,
      defInvalid,
      customerName: l.customer?.name ?? null,
      businessAreaName: l.businessArea?.name ?? null,
      updatedAt: l.updatedAt.toISOString(),
      prodSpecs: usedBy,
      styleCount: styles.length,
      styles: styles.slice(0, STYLE_CAP),
    };
  });

  return <LayoutsList layouts={layouts} contrastLogoFound={contrastLogo !== null} logoImageCount={logoImageCount} />;
}

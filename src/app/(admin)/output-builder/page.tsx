import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { LayoutsList } from "./layouts-list";

export const dynamic = "force-dynamic";

// Output Builder — list of operator-built layouts. Admin-only: the
// builder writes print-affecting config.
export default async function OutputBuilderPage() {
  const { role } = await getSessionWithRole();
  if (role !== "ADMIN") {
    return (
      <div className="px-8 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Output builder</h1>
        <p className="mt-3 text-sm text-zinc-500">The Output Builder is admin-only.</p>
      </div>
    );
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

  const layouts = rows.map((l) => {
    let pageCount = 0;
    let dims = "—";
    try {
      const def = parseLayoutDef(l.definition);
      pageCount = def.pages.length;
      dims = def.pages.map((p) => `${p.widthMm}×${p.heightMm}`).join(" · ");
    } catch {
      // invalid definition — editable, but show as such
      dims = "invalid definition";
    }
    return {
      id: l.id,
      name: l.name,
      docType: l.docType,
      status: l.status,
      version: l.version,
      pageCount,
      dims,
      customerName: l.customer?.name ?? null,
      businessAreaName: l.businessArea?.name ?? null,
      updatedAt: l.updatedAt.toISOString(),
    };
  });

  return <LayoutsList layouts={layouts} />;
}

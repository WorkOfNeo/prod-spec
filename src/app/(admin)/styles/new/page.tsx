import Link from "next/link";
import { db } from "@/lib/db";
import { ensureNettoGermany } from "@/lib/customers/resolve";
import { ManualStyleForm } from "./manual-style-form";

export const dynamic = "force-dynamic";

export default async function NewManualStylePage() {
  // Make sure at least one customer exists so the form has a target.
  await ensureNettoGermany();
  const [customers, suppliers, businessAreas, washSymbols, qrImages, prodSpecs] = await Promise.all([
    db.customer.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true },
    }),
    db.supplier.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, country: true },
    }),
    db.businessArea.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, mondayValue: true, name: true },
    }),
    db.washSymbol.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, svg: true },
    }),
    db.qrImage.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, image: true },
    }),
    // Every existing (Customer × BusinessArea) pair the form's customer-
    // and BA-selects might combine into. The form looks up against this
    // list as the user picks, so it can render a live "will link to: X"
    // preview without an extra API roundtrip.
    db.prodSpec.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        customerId: true,
        businessAreaId: true,
        outputs: true,
      },
    }),
  ]);

  const prodSpecLookup = prodSpecs.map((p) => ({
    id: p.id,
    name: p.name,
    customerId: p.customerId,
    businessAreaId: p.businessAreaId,
    outputsCount: Array.isArray(p.outputs) ? (p.outputs as unknown[]).length : 0,
  }));

  return (
    <div className="px-8 py-8">
      <Link href="/styles" className="text-xs text-zinc-500 underline">
        ← Back to styles
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New manual style</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Fill in the fields to render the ProdSpec PDFs without Monday integration. Use the
        sample-data button for a known-good starter, then iterate. Saved styles persist in the
        database and can be re-rendered or edited via the style detail page.
      </p>

      <ManualStyleForm
        mode="create"
        customers={customers}
        suppliers={suppliers}
        businessAreas={businessAreas}
        washSymbols={washSymbols}
        qrImages={qrImages}
        prodSpecs={prodSpecLookup}
      />
    </div>
  );
}

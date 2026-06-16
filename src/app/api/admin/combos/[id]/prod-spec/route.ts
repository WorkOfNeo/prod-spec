import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { backfillStyleProdSpecLinks, ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";

export const runtime = "nodejs";

// "Create" on the /combos dashboard: create (or locate) the ProdSpec for a
// combo's (customer × business area), pre-named "<Customer> - <Business
// area> - " so the admin lands in the editor with the prefix filled and just
// appends the season / specifics. Goes through the same ensure + backfill as
// the prod-specs "New" button, so the scaffold starts with identical defaults
// (inactive, no outputs) and any already-ingested Styles get wired up.
//
// Idempotent: a ProdSpec is unique per (customerId, businessAreaId), so if one
// already exists we return it WITHOUT renaming (the name override only lands
// on create). A combo with no resolved business area (baKey "none"/freetext →
// businessAreaId null) can't have a ProdSpec, so it's a 400 — the dashboard
// also disables the button in that case.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  const combo = await db.customerBusinessAreaCombo.findUnique({ where: { id } });
  if (!combo) return NextResponse.json({ error: "Combo not found" }, { status: 404 });
  if (!combo.businessAreaId) {
    return NextResponse.json(
      { error: "This combo has no business area, so it can't have a ProdSpec." },
      { status: 400 },
    );
  }

  // Live names for the prefix (canonical), falling back to the combo's
  // snapshot labels if a row vanished mid-flight.
  const [customer, businessArea] = await Promise.all([
    db.customer.findUnique({ where: { id: combo.customerId }, select: { name: true } }),
    db.businessArea.findUnique({ where: { id: combo.businessAreaId }, select: { name: true } }),
  ]);
  const name = `${customer?.name ?? combo.customerName} - ${businessArea?.name ?? combo.baLabel} - `;

  const created = await ensureProdSpecsForStyle(combo.customerId, combo.businessAreaId, { name });
  const backfilledStyles = await backfillStyleProdSpecLinks(combo.customerId, combo.businessAreaId);

  const prodSpec = await db.prodSpec.findUnique({
    where: {
      customerId_businessAreaId: {
        customerId: combo.customerId,
        businessAreaId: combo.businessAreaId,
      },
    },
    select: { id: true },
  });
  if (!prodSpec) {
    return NextResponse.json({ error: "ProdSpec not found after create" }, { status: 500 });
  }

  return NextResponse.json({ prodSpecId: prodSpec.id, created, backfilledStyles });
}

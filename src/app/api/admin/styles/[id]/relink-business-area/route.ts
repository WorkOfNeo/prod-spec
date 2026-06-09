import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";

export const runtime = "nodejs";

// Heal the "Style.businessArea text is set but Style.businessAreaId FK is
// null" case. Looks for an active BusinessArea row matching the text by
// either `mondayValue` or `name` (case-insensitive), links the FK, and
// auto-creates / attaches the ProdSpec for (customerId × businessAreaId).
//
// Idempotent: if the FK is already set, returns immediately. If no match
// is found, returns 404 with a list of available BA options so the
// operator can pick manually.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const style = await db.style.findUnique({ where: { id } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // Already linked — nothing to do.
  if (style.businessAreaId) {
    return NextResponse.json({ alreadyLinked: true, businessAreaId: style.businessAreaId });
  }

  const text = (style.businessArea ?? "").trim();
  if (!text) {
    return NextResponse.json(
      { error: "Style has no businessArea text to match — edit and pick a Business Area directly." },
      { status: 400 },
    );
  }

  // Try mondayValue exact-match first (case-insensitive) — that's the
  // canonical key. Fall back to display `name` if mondayValue doesn't
  // hit, since both are reasonable things to type.
  const allBAs = await db.businessArea.findMany({ where: { active: true } });
  const lowered = text.toLowerCase();
  const match =
    allBAs.find((b) => b.mondayValue.toLowerCase() === lowered) ??
    allBAs.find((b) => b.name.toLowerCase() === lowered);

  if (!match) {
    return NextResponse.json(
      {
        error: `No active Business Area matches "${text}".`,
        availableOptions: allBAs.map((b) => ({ id: b.id, mondayValue: b.mondayValue, name: b.name })),
      },
      { status: 404 },
    );
  }

  await ensureProdSpecsForStyle(style.customerId, match.id);
  const ps = await db.prodSpec.findUnique({
    where: { customerId_businessAreaId: { customerId: style.customerId, businessAreaId: match.id } },
  });

  const updated = await db.style.update({
    where: { id },
    data: {
      businessAreaId: match.id,
      prodSpecId: ps?.id ?? null,
    },
    select: { id: true, businessAreaId: true, prodSpecId: true },
  });

  await db.log.create({
    data: {
      level: "INFO",
      message: `style ${id} relinked to BusinessArea ${match.id} (${match.mondayValue})`,
      payload: { styleId: id, businessAreaId: match.id, prodSpecId: updated.prodSpecId },
    },
  });

  return NextResponse.json({
    linkedBusinessArea: { id: match.id, mondayValue: match.mondayValue, name: match.name },
    prodSpecId: updated.prodSpecId,
  });
}

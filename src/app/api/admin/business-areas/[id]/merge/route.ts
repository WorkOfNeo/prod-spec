// POST /api/admin/business-areas/{id}/merge
//
// Merge a BusinessArea (source) into another (target). After this runs:
//   - Every Style.businessAreaId pointing at source now points at target.
//   - Every ProdSpec(customer, source) either becomes ProdSpec(customer,
//     target) — if no conflict — or its Styles get moved onto the
//     existing ProdSpec(customer, target) and the source ProdSpec is
//     deleted. The target's outputs / requiredFields / threshold win.
//   - Source.mergedIntoId = target.id and source.active = false. The
//     Monday-value upsert in ingest.ts then redirects future ingests
//     onto the canonical target automatically.
//
// Idempotent re-runs are tolerated but a no-op once source has no
// remaining Styles / ProdSpecs. Wrapped in a transaction so a failure
// half-way through leaves the BA hierarchy untouched.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  targetId: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id: sourceId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { targetId } = parsed.data;

  if (sourceId === targetId) {
    return NextResponse.json({ error: "source and target must differ" }, { status: 400 });
  }

  const [source, target] = await Promise.all([
    db.businessArea.findUnique({ where: { id: sourceId } }),
    db.businessArea.findUnique({ where: { id: targetId } }),
  ]);
  if (!source) return NextResponse.json({ error: "source not found" }, { status: 404 });
  if (!target) return NextResponse.json({ error: "target not found" }, { status: 404 });
  if (target.mergedIntoId) {
    return NextResponse.json(
      { error: "target itself is an alias — pick the canonical BA" },
      { status: 400 },
    );
  }

  // Run the merge in one transaction. Order matters:
  //   1. Move Styles off the source ProdSpecs and onto target ProdSpecs
  //      (creates the target ProdSpec if none exists yet for that
  //      customer × target pair, by repointing the source row).
  //   2. Delete now-empty source ProdSpecs that conflicted.
  //   3. Repoint any Styles that didn't have a ProdSpec at all but did
  //      have the source BA (rare — orphan styles).
  //   4. Flag the source as merged + inactive.
  const result = await db.$transaction(async (tx) => {
    const sourceProdSpecs = await tx.prodSpec.findMany({
      where: { businessAreaId: sourceId },
      select: { id: true, customerId: true, _count: { select: { styles: true } } },
    });

    let prodSpecsMoved = 0;
    let prodSpecsMerged = 0;
    let stylesMoved = 0;

    for (const sp of sourceProdSpecs) {
      const conflict = await tx.prodSpec.findUnique({
        where: {
          customerId_businessAreaId: {
            customerId: sp.customerId,
            businessAreaId: targetId,
          },
        },
        select: { id: true },
      });
      if (conflict) {
        // Move source's styles onto target's ProdSpec, drop source.
        const moved = await tx.style.updateMany({
          where: { prodSpecId: sp.id },
          data: { prodSpecId: conflict.id, businessAreaId: targetId },
        });
        stylesMoved += moved.count;
        // Re-point any Jobs that snapshotted the source ProdSpec — keeps
        // analytics joins intact.
        await tx.job.updateMany({
          where: { prodSpecId: sp.id },
          data: { prodSpecId: conflict.id },
        });
        // Source ProdSpec is now styleless; delete (ProdSpecSupplier
        // cascades, Logs are on Job which still exists, etc.)
        await tx.prodSpec.delete({ where: { id: sp.id } });
        prodSpecsMerged++;
      } else {
        // No conflict — repoint the source ProdSpec to the target BA.
        // Same row id, same outputs config, just different BA pointer.
        // Move its Styles' businessAreaId in the same UPDATE so they
        // stay consistent.
        await tx.prodSpec.update({
          where: { id: sp.id },
          data: { businessAreaId: targetId },
        });
        const moved = await tx.style.updateMany({
          where: { prodSpecId: sp.id },
          data: { businessAreaId: targetId },
        });
        stylesMoved += moved.count;
        prodSpecsMoved++;
      }
    }

    // Catch any Styles that pointed at source BA but had no ProdSpec
    // (orphans — possible if ingest stored the BA before ProdSpec auto-
    // creation, or if the ProdSpec got deleted separately).
    const orphanMoved = await tx.style.updateMany({
      where: { businessAreaId: sourceId, prodSpecId: null },
      data: { businessAreaId: targetId },
    });
    stylesMoved += orphanMoved.count;

    await tx.businessArea.update({
      where: { id: sourceId },
      data: { mergedIntoId: targetId, active: false },
    });

    return {
      prodSpecsMoved,
      prodSpecsMerged,
      stylesMoved,
    };
  });

  return NextResponse.json({
    ok: true,
    source: { id: source.id, mondayValue: source.mondayValue, name: source.name },
    target: { id: target.id, mondayValue: target.mondayValue, name: target.name },
    ...result,
  });
}

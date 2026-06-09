// POST /api/admin/import/combinations/accept
//
// One-click acceptance of a new (Customer × BusinessArea) combination:
//   1. Auto-create the ProdSpec via the existing ensure primitive.
//   2. Backfill any pre-existing Styles whose pair matches.
//   3. Promote every UNAMBIGUOUS matching ghost item into a Style row,
//      reusing the same promote helper the bulk endpoint uses.
//   4. Trigger the runner once if anything got enqueued.
//
// Ambiguous matching items are intentionally NOT auto-promoted — they
// stay in the dashboard's disambiguation bucket so the operator picks
// the right customer per row.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  backfillStyleProdSpecLinks,
  ensureProdSpecsForStyle,
} from "@/lib/prod-spec/ensure";
import { findImportableForPair } from "@/lib/import/scan";
import { promoteGhostToStyle, PromoteError } from "@/lib/import/promote";
import { triggerRunner } from "@/lib/queue/trigger";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  customerId: z.string().min(1),
  businessAreaId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
  const { customerId, businessAreaId } = parsed.data;

  // ---------- Step 1: ensure ProdSpec ----------
  await ensureProdSpecsForStyle(customerId, businessAreaId);
  const prodSpec = await db.prodSpec.findUnique({
    where: { customerId_businessAreaId: { customerId, businessAreaId } },
  });
  if (!prodSpec) {
    return NextResponse.json(
      { error: "ProdSpec not found after upsert" },
      { status: 500 },
    );
  }

  // ---------- Step 2: backfill pre-existing Styles ----------
  const backfilledStyles = await backfillStyleProdSpecLinks(customerId, businessAreaId);

  // ---------- Step 3: promote unambiguous matching ghost items ----------
  const matches = await findImportableForPair(customerId, businessAreaId);
  let promoted = 0;
  let alreadyExisted = 0;
  let jobsEnqueued = 0;
  const failures: Array<{ ghostItemId: string; error: string; code?: string }> = [];
  for (const m of matches) {
    try {
      const r = await promoteGhostToStyle({ ghostItemId: m.ghostItemId, customerId });
      promoted++;
      if (r.alreadyExisted) alreadyExisted++;
      if (r.jobEnqueued) jobsEnqueued++;
    } catch (err) {
      if (err instanceof PromoteError) {
        failures.push({ ghostItemId: m.ghostItemId, error: err.message, code: err.code });
      } else {
        failures.push({ ghostItemId: m.ghostItemId, error: (err as Error).message });
      }
    }
  }

  if (jobsEnqueued > 0) {
    await triggerRunner();
  }

  return NextResponse.json({
    prodSpecId: prodSpec.id,
    backfilledStyles,
    promoted,
    alreadyExisted,
    jobsEnqueued,
    failures,
  });
}

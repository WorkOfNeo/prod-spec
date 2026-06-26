import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { getAutomationMinPo } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// Re-queue every already-resolved style (RESOLVED / PARTIAL) back to PENDING so
// the EAN runner re-scrapes its PO with the latest matching logic — the "apply
// the new matcher to the back-catalogue" action on /automation. The sweep
// deliberately skips RESOLVED/PARTIAL, so without this they'd never pick up a
// parser change.
//
// Operator-only (ADMIN session). Honors the PO cutoff exactly like the sweep
// (poSeq >= minPo) so we never strand a below-cutoff row in PENDING that the
// cutoff-bound runner can't claim. Only flips the status column — the existing
// StyleEan rows stay intact until each row actually re-resolves, so styles keep
// their current barcodes (and completion) until a fresh scrape replaces them.
export async function POST() {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const startedAt = Date.now();
  const minPo = await getAutomationMinPo();
  const res = await db.style.updateMany({
    where: {
      poNumber: { not: null },
      eanStatus: { in: ["RESOLVED", "PARTIAL"] },
      ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
    },
    data: { eanStatus: "PENDING" },
  });

  // Surface it in the /automation activity feed (shows as "requeued N").
  await db.cronRun.create({
    data: {
      kind: "po-eans",
      source: "session",
      requeued: res.count,
      note: `manual re-run of resolved EANs${minPo !== null ? ` (PO ≥ ${minPo})` : ""}`,
      durationMs: Date.now() - startedAt,
    },
  });

  return NextResponse.json({ requeued: res.count });
}

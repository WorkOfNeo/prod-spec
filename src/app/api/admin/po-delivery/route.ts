import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { checkPoDelivery, repairPoDelivery } from "@/lib/sharepoint/po-delivery-run";
import { ReconcileApplyError } from "@/lib/sharepoint/reconcile-folder";

export const runtime = "nodejs";
// A folder resolution + listing, plus a current-outputs walk per style on the
// PO. The repair adds an upload per missing document and a second full check
// before it deletes anything, so it needs real headroom: a repair that timed
// out between "uploaded" and "cleaned up the old files" would leave the folder
// holding both.
export const maxDuration = 300;

// =====================================================
// The PO delivery ledger.
//
//   GET  ?supplier=&po=  → the live check. Strictly read-only.
//   POST {supplierId, poNumber} → repair: re-push every document that is
//        missing or sitting under an old name, then clear the old files.
//
// Role gate mirrors the per-style folder reconcile: session or 401, canReview
// or 403. Reviewers already approve outputs and re-run generation, and this is
// narrower — it uploads an ALREADY-APPROVED document to the folder it was
// always destined for, and never changes what a document contains.
//
// There is deliberately no "repair everything, everywhere" endpoint. The unit
// is one PO folder, chosen by a person looking at its ledger.
// =====================================================

export async function GET(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const supplierId = req.nextUrl.searchParams.get("supplier")?.trim();
  const poNumber = req.nextUrl.searchParams.get("po")?.trim();
  if (!supplierId || !poNumber) {
    return NextResponse.json({ error: "supplier and po are both required" }, { status: 400 });
  }

  const report = await checkPoDelivery({ supplierId, poNumber });
  // no-store: this is a live folder snapshot, and a cached one would show drift
  // that has already been repaired — or hide drift that just appeared.
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { supplierId?: unknown; poNumber?: unknown };
  const supplierId = typeof body.supplierId === "string" ? body.supplierId.trim() : "";
  const poNumber = typeof body.poNumber === "string" ? body.poNumber.trim() : "";
  if (!supplierId || !poNumber) {
    return NextResponse.json({ error: "supplierId and poNumber are both required" }, { status: 400 });
  }

  try {
    const result = await repairPoDelivery({ supplierId, poNumber, userId: session.user.id });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // The lib's refusals are the USER's to resolve (folder moved, ambiguous PO
    // folder, write not granted) rather than bugs — keep their status.
    if (err instanceof ReconcileApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(`[po-delivery] repair failed for ${poNumber}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "PO delivery repair failed" },
      { status: 500 },
    );
  }
}

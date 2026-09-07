import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { runPoChecks, resolvePoSuppliers } from "@/lib/checks/run-po-checks";
import { applyCheckActions, loadCheckHistory, ApplyChecksError, type RequestedAction } from "@/lib/checks/apply-actions";

export const runtime = "nodejs";
// A folder resolution plus two listings, and a current-outputs walk per style on
// the PO. The apply adds one Graph write per file AND a second full check
// afterwards, so it needs real headroom: timing out between the writes and the
// re-check would leave the page showing a folder that no longer exists.
export const maxDuration = 300;

// =====================================================
// The /checks page's one endpoint.
//
//   GET  ?po=[&supplier=]  → the live checks for a PO folder. Strictly
//        read-only. Without ?supplier it resolves the supplier itself and, when
//        the PO genuinely appears under more than one, asks rather than guesses
//        — each supplier has its own folder.
//   POST {supplierId, poNumber, actions[]} → apply the picked actions.
//
// Role gate: session or 401, canReview or 403 — the same gate /delivery and the
// per-style folder reconcile use. Reviewers already approve outputs, re-run
// generation and repair delivery; this is the same job, from the folder's side.
//
// There is deliberately no endpoint that acts on more than ONE PO folder. The
// unit is a folder a person is looking at. Every validation of what may
// actually be touched lives in applyCheckActions, not here — this handler
// parses and gates, and it does not get to decide what is safe.
// =====================================================

export async function GET(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const poNumber = req.nextUrl.searchParams.get("po")?.trim();
  if (!poNumber) return NextResponse.json({ error: "po is required" }, { status: 400 });
  const asked = req.nextUrl.searchParams.get("supplier")?.trim() || null;

  const suppliers = await resolvePoSuppliers(poNumber);
  if (suppliers.length === 0) {
    return NextResponse.json(
      { error: `No live style on PO “${poNumber}” has a supplier, so there is no folder to check.` },
      { status: 404 },
    );
  }
  const supplierId =
    asked && suppliers.some((s) => s.supplierId === asked)
      ? asked
      : suppliers.length === 1
        ? suppliers[0].supplierId
        : null;
  if (!supplierId) {
    // Two orders sharing a PO reference are two folders. Never auto-pick.
    return NextResponse.json({ needsSupplier: suppliers }, { headers: { "Cache-Control": "no-store" } });
  }

  const [report, history] = await Promise.all([
    runPoChecks({ supplierId, poNumber }),
    loadCheckHistory(poNumber),
  ]);
  // no-store: a live folder snapshot. A cached one would show findings that
  // have already been repaired, or hide ones that just appeared — and this page
  // hands people a delete button on the strength of what it shows.
  return NextResponse.json({ report, history }, { headers: { "Cache-Control": "no-store" } });
}

// Parse the requested actions defensively. Everything that matters is
// re-validated against a FRESH check inside applyCheckActions; this only turns
// unknown JSON into the right shape without throwing.
function parseActions(raw: unknown): RequestedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: RequestedAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const checkId = a.checkId;
    const action = a.action;
    if (checkId !== "cover-pages" && checkId !== "output-file-names") continue;
    if (action !== "delete" && action !== "rename") continue;
    if (typeof a.itemId !== "string" || typeof a.fileName !== "string") continue;
    out.push({
      checkId,
      action,
      itemId: a.itemId,
      fileName: a.fileName,
      newName: typeof a.newName === "string" ? a.newName : undefined,
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const supplierId = typeof body.supplierId === "string" ? body.supplierId.trim() : "";
  const poNumber = typeof body.poNumber === "string" ? body.poNumber.trim() : "";
  if (!supplierId || !poNumber) {
    return NextResponse.json({ error: "supplierId and poNumber are both required" }, { status: 400 });
  }
  const actions = parseActions(body.actions);

  try {
    const result = await applyCheckActions({
      supplierId,
      poNumber,
      actions,
      userId: session.user.id,
      userEmail: session.user.email,
    });
    const history = await loadCheckHistory(poNumber);
    return NextResponse.json({ ok: true, ...result, history }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // The lib's refusals are the USER's to resolve (folder moved, ambiguous PO
    // folder, too many files at once) rather than bugs — keep their status.
    if (err instanceof ApplyChecksError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(`[checks] apply failed for ${poNumber}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The folder change failed" },
      { status: 500 },
    );
  }
}

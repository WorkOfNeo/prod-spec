import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { getCurrentOutputsForStyle } from "@/lib/outputs/current-outputs";
import { pushApprovedAssetsToSupplier, SupplierPushError } from "@/lib/sharepoint/push-to-supplier";

export const runtime = "nodejs";
export const maxDuration = 120;

// Admin-only: push ALL approved, print-safe outputs for a style into the
// supplier's SharePoint folder in one request (folder resolved + ensured once,
// rather than looping client-side — push has no per-asset settlement). The
// pushable set is recomputed server-side from the style's current outputs, so
// it can't be widened by the caller. ?dryRun=1 previews the target.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const outputs = await getCurrentOutputsForStyle(id);
  const assetIds = outputs
    .filter((o) => o.reviewStatus === "APPROVED" && o.placeholderCount === 0 && o.jobAssetId)
    .map((o) => o.jobAssetId as string);

  if (assetIds.length === 0) {
    return NextResponse.json(
      { error: "No approved, print-safe outputs to push for this style." },
      { status: 409 },
    );
  }

  try {
    const result = await pushApprovedAssetsToSupplier({
      styleId: id,
      assetIds,
      dryRun,
      userId: session.user.id,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SupplierPushError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: `Push failed: ${(err as Error).message}` }, { status: 500 });
  }
}

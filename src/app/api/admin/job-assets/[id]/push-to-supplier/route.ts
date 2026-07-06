import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { pushApprovedAssetsToSupplier, SupplierPushError } from "@/lib/sharepoint/push-to-supplier";

export const runtime = "nodejs";
export const maxDuration = 120;

// Admin-only: push ONE approved output's PDF into its supplier's SharePoint
// folder, under a "<PO> - <customer> - <supplier>" folder → "APPROVED LAYOUTS"
// subfolder. Manual counterpart to the
// auto publish-on-approval upload. ?dryRun=1 resolves the target folder + file
// name WITHOUT writing — verifiable before FLC enables write.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const asset = await db.jobAsset.findUnique({
    where: { id },
    select: { id: true, job: { select: { styleId: true } } },
  });
  if (!asset) return NextResponse.json({ error: "Output not found" }, { status: 404 });

  try {
    const result = await pushApprovedAssetsToSupplier({
      styleId: asset.job.styleId,
      assetIds: [id],
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

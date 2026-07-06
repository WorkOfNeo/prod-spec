import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { backfillSupplierFolders } from "@/lib/publish/backfill-supplier-folders";

export const runtime = "nodejs";
export const maxDuration = 300;

// Re-push already-delivered styles into the NEW supplier-folder naming
// ("<PO> - <customer> - <supplier> - APPROVED LAYOUTS"). ADMIN only. The
// folder-name change is forward-only, so styles already pushed to an old-named
// folder need a one-off consolidation — this is the button that does it, from
// /settings/approved. Uses the manual push path, so it runs regardless of the
// "Automatic supplier sending" toggle. ?dryRun=1 resolves targets without
// writing (useful to preview scope/permissions before the real run).
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const result = await backfillSupplierFolders({ dryRun, userId: auth.userId });
  return NextResponse.json({ ok: true, ...result });
}

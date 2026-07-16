import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { fixOutputFileNames } from "@/lib/sharepoint/fix-output-filenames";

export const runtime = "nodejs";
export const maxDuration = 300;

// Reconcile every UPLOADED supplier output's SharePoint filename with what its
// layout's CURRENT template says it should be, renaming drifted files in place
// (Graph PATCH) and correcting our stored name. ADMIN only. Runs regardless of
// the "Automatic supplier sending" toggle. ?dryRun=1 returns the plan
// (old → new per file) without touching SharePoint or the DB — the button
// previews first, then applies.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const result = await fixOutputFileNames({ dryRun });
  return NextResponse.json({ ok: true, ...result });
}

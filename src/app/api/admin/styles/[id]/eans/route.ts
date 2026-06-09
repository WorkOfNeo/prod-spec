import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { resolveAndPersistStyleEans } from "@/lib/po/ean-runner";

export const runtime = "nodejs";
// Downloading + parsing a PO PDF from SharePoint can take a few seconds.
export const maxDuration = 60;

// Manual "Re-resolve": resolve a style's EANs end-to-end (PO on the style →
// SharePoint PO PDF → parse → size/colour EANs + carton EAN) AND persist the
// result so it matches what the queued runner would store. Returns the
// UI-ready EanView (persisted StyleEanStatus + per-size EANs).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const view = await resolveAndPersistStyleEans(id);
  return NextResponse.json(view);
}

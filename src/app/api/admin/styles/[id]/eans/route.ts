import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { db } from "@/lib/db";
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
  // A human clicking Re-resolve is an explicit override: clear the strike
  // counter so a floated row un-floats and gets a fresh MAX_EAN_ATTEMPTS
  // budget. resolveAndPersistStyleEans then sets it to 0 (success) or 1
  // (this attempt failed) — never straight back to floated.
  await db.style.updateMany({ where: { id }, data: { eanAttempts: 0 } });
  // Force the Monday barcode-column fallback: a manual re-resolve reset the
  // strike counter above, so the "budget spent" auto-trigger won't fire — but
  // a human explicitly asking to resolve wants the best available answer, so
  // consult Monday whenever this attempt's PO scrape comes up empty.
  const view = await resolveAndPersistStyleEans(id, { forceMondayFallback: true });
  return NextResponse.json(view);
}

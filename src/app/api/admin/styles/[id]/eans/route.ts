import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { resolveAndPersistStyleEans } from "@/lib/po/ean-runner";
import {
  applyEanOverride,
  EanOverrideError,
  type EanOverrideOp,
} from "@/lib/po/ean-override-actions";

export const runtime = "nodejs";
// Downloading + parsing a PO PDF from SharePoint can take a few seconds.
export const maxDuration = 60;

// Parse + validate the override op off the request body, rejecting anything
// that doesn't match the small union (so the action layer only sees shapes it
// understands).
function parseOp(body: unknown): EanOverrideOp | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.op === "toggle" && typeof b.id === "string" && typeof b.excluded === "boolean") {
    return { op: "toggle", id: b.id, excluded: b.excluded };
  }
  if (b.op === "add" && typeof b.size === "string" && typeof b.ean13 === "string") {
    return { op: "add", size: b.size, ean13: b.ean13 };
  }
  if (b.op === "delete" && typeof b.id === "string") {
    return { op: "delete", id: b.id };
  }
  return null;
}

// Manual EAN override: hide / un-hide a scraped row, add a missing one, or
// delete a hand-added one. Mutates style_eans directly (no SharePoint) and
// returns the refreshed EanView. Overrides survive a later re-resolve (see
// reconcileEans).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const op = parseOp(await req.json().catch(() => null));
  if (!op) return NextResponse.json({ error: "Invalid override request" }, { status: 400 });

  try {
    const view = await applyEanOverride(id, op);
    return NextResponse.json(view);
  } catch (e) {
    if (e instanceof EanOverrideError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

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

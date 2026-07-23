import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { resolveAndPersistStyleEans } from "@/lib/po/ean-runner";
import {
  applyEanOverride,
  EanOverrideError,
  loadStyleEanView,
  type EanOverrideOp,
} from "@/lib/po/ean-override-actions";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";

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

// Manual EAN override: hide / un-hide a scraped row, add a missing one, delete
// a hand-added one, or flip the per-style colour source for repeat-per-EAN
// rendering. Mutates style_eans / Style directly (no SharePoint) and returns
// the refreshed EanView. Overrides survive a later re-resolve (see
// reconcileEans).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);

  // Colour-source toggle: persist Style.useStyleBoardColour and re-render the
  // style so the change is visible on its per-EAN barcodes. Kept out of
  // applyEanOverride (which is deliberately SharePoint-/job-free) — it's a
  // Style-level render preference, not a style_eans row edit.
  if (body && typeof body === "object" && (body as { op?: unknown }).op === "colourSource") {
    const useStyleBoardColour = (body as { useStyleBoardColour?: unknown }).useStyleBoardColour;
    if (typeof useStyleBoardColour !== "boolean") {
      return NextResponse.json({ error: "useStyleBoardColour must be a boolean" }, { status: 400 });
    }
    const updated = await db.style.updateMany({ where: { id }, data: { useStyleBoardColour } });
    if (updated.count === 0) return NextResponse.json({ error: "Style not found" }, { status: 404 });

    // Re-render so the toggle takes effect — but never step on an in-flight
    // job (mirrors the style PATCH route's guard). Approved outputs are skipped
    // by the runner regardless, so this refreshes the not-yet-approved ones.
    let jobId: string | null = null;
    const inflight = await db.job.count({
      where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (inflight === 0) {
      ({ jobId } = await enqueueGenerationJob({ styleId: id, triggerSource: "MANUAL_RERUN" }));
      await db.log.create({
        data: { jobId, level: "INFO", message: `colour source set to ${useStyleBoardColour ? "style board" : "PO"} — re-rendering` },
      });
      await runPendingJobs(1);
    }

    const view = await loadStyleEanView(id);
    return NextResponse.json({ ...view, regenerated: jobId !== null });
  }

  const op = parseOp(body);
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

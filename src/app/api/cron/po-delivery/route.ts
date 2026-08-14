import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { sweepPoDelivery } from "@/lib/sharepoint/po-delivery-run";

export const runtime = "nodejs";
export const maxDuration = 300;

// =====================================================
// PO delivery sweep — the detect half of the self-healing loop.
//
// Rotates through the deliverable PO folders least-recently-checked first and
// records, per (supplier, PO), how many approved documents actually reached the
// supplier's folder. The fleet list at /delivery reads those rows; the detail
// page re-checks live, so nothing ever repairs against a stale snapshot.
//
// READ-ONLY. It deliberately does NOT repair. Repair uploads into a supplier's
// own folder, which is outward-facing, and a bad template edit propagating
// unattended across every PO is exactly the failure that is hard to walk back.
// A person presses the button; this only ever makes sure they know to.
//
// `limit` bounds the Graph spend per tick: each folder costs ~5 sequential
// calls plus a current-outputs walk per style on it. Default 25 — a few hundred
// folders therefore come round over the course of a day on a 30-minute cron.
// Raise it deliberately, not by habit.
// =====================================================

export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : undefined;

  try {
    const result = await sweepPoDelivery({ limit });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/po-delivery] sweep failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "PO delivery sweep failed" },
      { status: 500 },
    );
  }
}

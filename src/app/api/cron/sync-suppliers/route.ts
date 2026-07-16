import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { sinkBoard, type SinkResult } from "@/lib/monday/sink";
import { syncSuppliers, syncSupplierContacts, type SyncResult } from "@/lib/monday/sync";
import { retroLinkStyleSuppliers } from "@/lib/monday/retro-link";
import { runAndRespond } from "@/lib/monday/sync-route";
import { serr } from "@/lib/monday/sync-log";

export const runtime = "nodejs";
export const maxDuration = 300;

// End-to-end supplier refresh — the one URL both the /monday Fill → Suppliers
// button and the Railway cron hit:
//
//   1. sink the Supplier Companies board   (Monday → ghost mirror)
//   2. fill suppliers                      (ghost mirror → suppliers table)
//   3. sink + fill Supplier Contacts       (contacts resolve through step 2)
//   4. retro-link styles                   (late suppliers reach their styles)
//
// Fill-only (the previous behaviour) was a trap: it re-reads whatever the
// ghost mirror holds, so without a preceding sink it "succeeds" on stale
// data and a supplier created on Monday since the last sink never arrives.
// The supplier boards also accept no webhook registration for our API user
// (Monday: "User unauthorized to perform action"), so unlike styles there is
// no live push to lean on — a periodic pull through this route is the only
// thing keeping the supplier mirror fresh. Schedule it every ~6h via
// `?secret=$JOB_RUNNER_SECRET` (see src/lib/cron/auth.ts).
export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runAndRespond("sync-suppliers", async () => {
    const supplierSink = await sinkBoard(MONDAY_BOARDS.suppliers);
    const suppliers = await syncSuppliers();

    // Contacts ride along fail-soft — a contacts hiccup must not undo the
    // supplier refresh above (same degradation syncAll applies).
    let contactsSink: SinkResult | null = null;
    let contacts: SyncResult | null = null;
    try {
      contactsSink = await sinkBoard(MONDAY_BOARDS.supplierContacts);
      contacts = await syncSupplierContacts();
    } catch (err) {
      serr("sync-suppliers", "supplier contacts refresh failed (continuing)", err);
    }

    const retroLink = await retroLinkStyleSuppliers();
    return { supplierSink, suppliers, contactsSink, contacts, retroLink };
  });
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with ?secret=<JOB_RUNNER_SECRET> or signed-in admin session.",
  });
}

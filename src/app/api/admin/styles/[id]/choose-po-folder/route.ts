import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { pushQueuedSupplierUploads } from "@/lib/sharepoint/push-queued-to-supplier";

export const runtime = "nodejs";
// Choosing the folder re-arms the queue and pushes into it right away — the
// Graph upload can take a few seconds.
export const maxDuration = 120;

// Pick the PO folder for a style when the supplier's SharePoint has several
// folders matching its PO (AMBIGUOUS). Employees create PO folders manually and
// occasionally end up with duplicates; instead of the app deleting or guessing,
// a user selects the right one and we remember it (Style.supplierPoFolderName)
// so every push/verify sends to exactly that folder.
//
// Deliberately open to ALL signed-in roles (not admin-only): whoever is closest
// to the data should be able to unblock delivery. Requires only a session.
//
// On selection: persist the choice, re-arm the style's unsent, not-yet-uploaded
// queue rows (so the sweep uploads into the chosen folder), and kick an
// immediate push so the files land without waiting for the next cron tick.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { folderName?: unknown };
  const folderName = typeof body.folderName === "string" ? body.folderName.trim() : "";
  if (!folderName) {
    return NextResponse.json({ error: "folderName is required" }, { status: 400 });
  }

  const style = await db.style.findUnique({
    where: { id },
    select: { id: true, jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } } },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  await db.style.update({ where: { id }, data: { supplierPoFolderName: folderName } });

  // Re-arm the style's pending delivery so the push resolves to the chosen
  // folder next: everything unsent that isn't already uploaded goes back to
  // PENDING (clearing the ambiguity links + strike count).
  const rearmed = await db.supplierSendQueueItem.updateMany({
    where: { styleId: id, sentAt: null, sharePointStatus: { not: "UPLOADED" } },
    data: { sharePointStatus: "PENDING", pushAttempts: 0, sharePointFolderMatches: null },
  });

  await db.log.create({
    data: {
      jobId: style.jobs[0]?.id ?? null, // attach to the latest job so it shows on the style history
      level: "INFO",
      message: `PO folder chosen: “${folderName}” — re-armed ${rearmed.count} queued output(s) for upload · by ${session.user.email}`,
    },
  });

  // Push into the chosen folder immediately (fail-soft + flag-gated inside the
  // lib). Anything that can't push this instant stays queued for the sweep.
  let sweep: Awaited<ReturnType<typeof pushQueuedSupplierUploads>> | null = null;
  try {
    sweep = await pushQueuedSupplierUploads({ styleIds: [id], recordRunAs: "operator" });
  } catch (err) {
    console.warn(`[choose-po-folder] immediate push failed for style ${id}:`, err);
  }

  return NextResponse.json({ ok: true, folderName, rearmed: rearmed.count, sweep });
}

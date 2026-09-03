import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { removeFromApprovedLayouts } from "@/lib/sharepoint/upload";

export const runtime = "nodejs";
export const maxDuration = 60;

// One stored manual-trim document.
//
//   GET    /api/admin/styles/<id>/manual-trims/<uploadId>  → the bytes back
//   DELETE /api/admin/styles/<id>/manual-trims/<uploadId>  → un-supply the line
//
// Both are scoped to the style in the path, so an id belonging to another
// style can't be read or deleted through this route.
//
// Both gate on canReview (ADMIN *and* REVIEWER), matching the POST next door:
// whoever may supply the document may take it back again.
//
// DELETE removes the file from the supplier's folder as well as the row. That
// is the point: the cover promised the supplier this document, and leaving an
// orphan file behind after the promise is withdrawn is how the folder and the
// manifest drift apart. It is an explicit, person-initiated action on a file
// this app put there itself — never a sweep, never a cleanup. If SharePoint
// refuses the delete, the row STAYS (with the reason) rather than being dropped
// on the floor, so nothing claims the supplier's folder is clean when it isn't.
//
// ITS REACH IS THE ROW, AND ONLY THE ROW. The drive id and item id handed to
// Graph are the ones THIS feature recorded when it uploaded the file, read off
// a StyleManualTrimUpload scoped to the style in the path — never a name, a
// path, a folder, or anything found by listing the folder. So a widened gate
// widens who may delete their own uploaded trim document, and nothing else: an
// approved output PDF, another style's file, and the APPROVED LAYOUTS folder
// itself are all unreachable from here. manual-trims-delete-scope.test.ts pins
// that.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; uploadId: string }> },
) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role))
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const { id, uploadId } = await ctx.params;
  const row = await db.styleManualTrimUpload.findFirst({
    where: { id: uploadId, styleId: id },
    select: { file: true, mimeType: true, fileName: true },
  });
  if (!row) return NextResponse.json({ error: "Upload not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(row.file), {
    status: 200,
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      // inline so a PDF opens in the browser tab rather than downloading.
      "Content-Disposition": `inline; filename="${row.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; uploadId: string }> },
) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role))
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const { id, uploadId } = await ctx.params;
  const row = await db.styleManualTrimUpload.findFirst({
    where: { id: uploadId, styleId: id },
    select: { id: true, sharepointDriveId: true, sharepointItemId: true, trimLabel: true, fileName: true },
  });
  // Already gone — the caller's goal is met, so this is a success.
  if (!row) return NextResponse.json({ ok: true, deleted: false });

  if (row.sharepointDriveId && row.sharepointItemId) {
    try {
      await removeFromApprovedLayouts(row.sharepointDriveId, row.sharepointItemId);
    } catch (err) {
      const message = `Couldn't remove the file from the supplier's folder — ${(err as Error).message}`;
      await db.styleManualTrimUpload.update({
        where: { id: row.id },
        data: { uploadError: message },
      });
      return NextResponse.json({ error: message }, { status: 409 });
    }
  }

  await db.styleManualTrimUpload.delete({ where: { id: row.id } });

  const latestJob = await db.job.findFirst({
    where: { styleId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  await db.log
    .create({
      data: {
        jobId: latestJob?.id ?? null,
        level: "INFO",
        message: `manual trim removed · ${row.trimLabel} (${row.fileName})`,
        payload: { styleId: id, label: row.trimLabel, fileName: row.fileName, byUserId: session.user.id },
      },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, deleted: true });
}

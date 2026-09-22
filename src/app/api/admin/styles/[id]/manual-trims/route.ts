import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { toPlainBytes } from "@/lib/pdf/bytes";
import { buildRequiredPackagingForStyle } from "@/lib/outputs/required-packaging";
import { getTrimsOnCoverEnabled } from "@/lib/settings/app-settings";
import { listManualTrimUploads, normalizeTrimLabel } from "@/lib/trims/manual-uploads";
import { scheduleCoverRegen } from "@/lib/pdf/cover-regen-schedule";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { manualTrimFileName, MANUAL_TRIM_EXTENSIONS } from "@/lib/trims/manual-upload-name";
import {
  ApprovedLayoutsFolderError,
  uploadIntoApprovedLayouts,
} from "@/lib/sharepoint/upload";

export const runtime = "nodejs";
export const maxDuration = 120;

// =====================================================
// The manually-supplied trim documents for one style.
//
//   GET   /api/admin/styles/<id>/manual-trims       → the manifest's manual
//         lines, each with its stored upload (or null)
//   POST  /api/admin/styles/<id>/manual-trims       multipart: label + file
//   PATCH /api/admin/styles/<id>/manual-trims       json: label + approved
//
// POST AND PATCH ANSWER THE SAME QUESTION BY DIFFERENT MEANS. POST hands this
// app the document and lets it do the upload. PATCH is for the document that is
// ALREADY in the supplier's folder because a person put it there — a cover line
// waiting on a file the operator mailed across, or an upload this app couldn't
// push (no PO folder yet) that they then carried over by hand. Both end with
// the cover saying the same thing about that line, because from the supplier's
// side the outcome is the same: the folder holds the document.
//
// PATCH SENDS NO TRIM FILE AND RECORDS NO DRIVE/ITEM ID, so nothing downstream
// — the DELETE next door included — can use it to reach a file this app did not
// put there.
//
// WHAT EVERY MUTATION HERE DOES DO is stamp the style into the cover-regen
// debounce ledger (scheduleCoverRegen), exactly as approving or rejecting an
// output does. Supplying a line only moves a row in this database; the cover
// the supplier holds is a PDF, and leaving it saying "Waiting for Customer
// Information" about a document already in their folder is the feature not
// actually happening. The ledger's drain rebuilds the cover in place, re-arms
// the supplier-send row and pushes it — one mechanism, shared with output
// decisions, debounced so three approvals in a row are one render rather than
// three, and durable: the demand is in the DB, so a lost in-process timer is
// picked up by /api/cron/cover-regen rather than dropped.
//
// THE LABELS COME FROM THE MANIFEST, NEVER FROM THE CLIENT. The whole point of
// the panel is that its zones read exactly as the cover reads, so the server
// builds the cover's manifest (the same buildRequiredPackagingForStyle every
// cover render uses), takes the rows whose kind is "manual", and POST refuses
// any label that isn't one of them. A typo'd or stale label therefore can't
// create an upload nothing on the cover will ever point at.
//
// WHO MAY DO THIS: canReview — ADMIN *and* REVIEWER. Supplying the document a
// cover line is waiting on is part of getting a style reviewable, not an admin
// chore, so this gates the same way approval and /delivery already do rather
// than on isAdmin. Enforced here, at the API; note AUTH_DISABLED forces ADMIN
// in dev, so the role-gate test is the only proof of this.
//
// The file goes into the style's APPROVED LAYOUTS folder — where approved
// outputs land and where the supplier looks. That folder is PO-SCOPED and
// shared by every style on the PO, so the name is built by manualTrimFileName()
// rather than from the uploaded file's own name.
// =====================================================

// Graph's direct PUT is good to ~4 MB (see uploadIntoFolder); above that it
// needs an upload session, so refuse rather than fail halfway.
const MAX_BYTES = 4_000_000;

// The manifest line a caller's label names, or null. Shared by POST and PATCH
// so "is this a live manually-supplied line?" is decided once: both write a row
// keyed on the normalised label, and a label only one of them accepted would
// put a row on the cover's blind side.
async function resolveManualLine(styleId: string, label: string) {
  const manifest = await buildRequiredPackagingForStyle(styleId);
  const normalized = normalizeTrimLabel(label);
  const line = manifest.find(
    (r) => r.kind === "manual" && normalizeTrimLabel(r.displayName) === normalized,
  );
  return line ? { line, normalized } : null;
}

const STALE_LABEL =
  "That isn't a manually-supplied line on this style's cover any more — reload the page to see the current list.";

// Audit line, hung off the style's newest run so it lands in the same activity
// feed as generation / approval / push events (Log has no styleId of its own).
// Best-effort: a style that has never generated has no job to hang it on, and
// that must not fail an action that already succeeded.
async function auditLog(styleId: string, message: string, payload: Prisma.InputJsonObject) {
  const latestJob = await db.job.findFirst({
    where: { styleId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  await db.log
    .create({ data: { jobId: latestJob?.id ?? null, level: "INFO", message, payload } })
    .catch(() => {});
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role))
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const { id } = await ctx.params;
  const style = await db.style.findUnique({ where: { id }, select: { id: true } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const [rows, uploads, trimsEnabled] = await Promise.all([
    buildRequiredPackagingForStyle(id),
    listManualTrimUploads(id),
    getTrimsOnCoverEnabled(),
  ]);

  const byLabel = new Map(uploads.map((u) => [u.normalizedLabel, u]));

  // One entry per MANUAL manifest line, labelled with the string the cover
  // prints (displayName), in cover order.
  const lines = rows
    .filter((r) => r.kind === "manual")
    .map((r) => ({
      label: r.displayName,
      normalizedLabel: normalizeTrimLabel(r.displayName),
      upload: byLabel.get(normalizeTrimLabel(r.displayName)) ?? null,
    }));

  // Uploads whose manifest line has since disappeared (the Trims cell was
  // edited, or an override now suppresses the label). Surfaced rather than
  // hidden: the file is still sitting in the supplier's folder.
  const orphaned = uploads.filter((u) => !lines.some((l) => l.normalizedLabel === u.normalizedLabel));

  return NextResponse.json({
    trimsEnabled,
    accepts: MANUAL_TRIM_EXTENSIONS,
    maxBytes: MAX_BYTES,
    lines,
    orphaned,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role))
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const { id } = await ctx.params;

  // multipart/form-data — the file goes to SharePoint as bytes either way, and
  // a data URL would inflate it by a third against a 4 MB ceiling.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload" }, { status: 400 });
  }

  const label = String(form.get("label") ?? "").trim();
  const file = form.get("file");
  if (!label) return NextResponse.json({ error: "Missing label" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1_000_000).toFixed(1)} MB — the limit is 4 MB.` },
      { status: 400 },
    );
  }

  const style = await db.style.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      mondayItemId: true,
      poNumber: true,
      supplierPoFolderName: true,
      supplier: { select: { name: true, sharepointUrl: true } },
    },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // The label must be a manual line of THIS style's manifest, matched on the
  // normalised form so a re-typed apostrophe or a case change still lands on
  // the row it means. The stored trimLabel is the manifest's own wording, not
  // the caller's — so the panel and the cover can never disagree.
  const resolved = await resolveManualLine(id, label);
  if (!resolved) return NextResponse.json({ error: STALE_LABEL }, { status: 409 });
  const { line, normalized } = resolved;

  // The colourway, resolved through the SAME chain the cover file name uses
  // (StyleData.colour), so a manual document sorts beside the cover of the
  // colourway it belongs to instead of inventing a second answer.
  const renderCtx = await loadStyleRenderContext(id);

  const fileName = manualTrimFileName({
    styleNumber: renderCtx?.styleData.styleNumber ?? style.name,
    colour: renderCtx?.styleData.colour ?? null,
    styleKey: style.mondayItemId,
    label: line.displayName,
    originalFileName: file.name,
  });
  if (!fileName) {
    return NextResponse.json(
      { error: `“${file.name}” isn't a format we can send on. Accepted: ${MANUAL_TRIM_EXTENSIONS.join(", ")}.` },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Store FIRST, push second. A PO folder that doesn't exist yet is a normal,
  // self-healing state (an employee creates it later); losing the operator's
  // file because of it is not. The row only counts as delivered once Graph has
  // taken it — see loadManualDeliveredLabels.
  const stored = await db.styleManualTrimUpload.upsert({
    where: { styleId_normalizedLabel: { styleId: id, normalizedLabel: normalized } },
    create: {
      styleId: id,
      trimLabel: line.displayName,
      normalizedLabel: normalized,
      originalName: file.name,
      fileName,
      mimeType: file.type || "application/octet-stream",
      byteSize: bytes.byteLength,
      file: toPlainBytes(bytes),
      uploadedById: session.user.id,
    },
    update: {
      trimLabel: line.displayName,
      originalName: file.name,
      fileName,
      mimeType: file.type || "application/octet-stream",
      byteSize: bytes.byteLength,
      file: toPlainBytes(bytes),
      uploadedById: session.user.id,
      // A replacement is not delivered until the new bytes are up there — and
      // that includes superseding a hand-approval. Somebody stating the folder
      // held the OLD document says nothing about this one, so the stamp goes
      // and the line waits on the push like any other upload.
      sharepointItemId: null,
      sharepointDriveId: null,
      sharepointWebUrl: null,
      deliveredAt: null,
      manualApprovedAt: null,
      manualApprovedById: null,
      uploadError: null,
    },
    select: { id: true },
  });

  const sharingUrl = style.supplier?.sharepointUrl?.trim();
  if (!sharingUrl) {
    const message = style.supplier
      ? `No SharePoint folder on file for supplier “${style.supplier.name}” — set the Supplier Folder link on the Monday Suppliers board and re-sync, then retry.`
      : "This style has no linked supplier — set the supplier on the Monday Pre-Order board and re-sync, then retry.";
    await db.styleManualTrimUpload.update({
      where: { id: stored.id },
      data: { uploadError: message },
    });
    return NextResponse.json({ ok: true, delivered: false, error: message, id: stored.id }, { status: 200 });
  }

  try {
    const up = await uploadIntoApprovedLayouts({
      target: {
        sharingUrl,
        poNumber: style.poNumber,
        preferredFolderName: style.supplierPoFolderName,
      },
      fileName,
      content: bytes,
    });

    await db.styleManualTrimUpload.update({
      where: { id: stored.id },
      data: {
        fileName: up.fileName,
        sharepointDriveId: up.driveId,
        sharepointItemId: up.itemId,
        sharepointWebUrl: up.webUrl,
        deliveredAt: new Date(),
        uploadError: null,
      },
    });

    await auditLog(id, `manual trim uploaded · ${line.displayName} → ${up.fileName}`, {
      styleId: id,
      label: line.displayName,
      fileName: up.fileName,
      webUrl: up.webUrl,
      byUserId: session.user.id,
    });

    // The line now reads as supplied, so the cover has to say so — in the
    // supplier's folder, not just in our database.
    await scheduleCoverRegen(id);

    return NextResponse.json({
      ok: true,
      delivered: true,
      id: stored.id,
      fileName: up.fileName,
      webUrl: up.webUrl,
      coverQueued: true,
    });
  } catch (err) {
    const message =
      err instanceof ApprovedLayoutsFolderError
        ? err.message
        : `SharePoint refused the upload — ${(err as Error).message}`;
    await db.styleManualTrimUpload.update({
      where: { id: stored.id },
      data: { uploadError: message },
    });
    // 200, not 5xx: the file IS saved and the panel needs to say so. The
    // `delivered:false` + message is the honest report.
    return NextResponse.json({ ok: true, delivered: false, error: message, id: stored.id });
  }
}

// =====================================================
// PATCH — "the supplier already has this one; I put it there myself."
//
// Body: { label, approved }. `approved: true` stamps the line as supplied;
// `approved: false` takes the statement back.
//
// WHAT IT DOES NOT DO is the point of it. No file is read, no Graph call is
// made, no drive or item id is recorded. The row it writes holds a person's
// word and nothing else, so the cover can stop saying "Waiting for Customer
// Information" about a document that is demonstrably already in the folder.
// Attribution (manualApprovedById) and the audit line are what make that word
// accountable — this is a claim someone makes, not a fact the app verified.
//
// WITHDRAWING IT NEVER DELETES A FILE ANYWHERE. A row that exists only to carry
// the stamp is dropped outright; a row that also holds bytes this app stored
// keeps them and simply stops claiming the folder has them. Either way
// SharePoint is untouched — we did not put that document there.
// =====================================================
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role))
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const { id } = await ctx.params;

  let body: { label?: unknown; approved?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const label = String(body.label ?? "").trim();
  if (!label) return NextResponse.json({ error: "Missing label" }, { status: 400 });
  if (typeof body.approved !== "boolean") {
    return NextResponse.json({ error: "Missing approved (true/false)" }, { status: 400 });
  }
  const approved = body.approved;

  const style = await db.style.findUnique({ where: { id }, select: { id: true } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // Same gate as POST: the label has to be a manual line of THIS style's
  // manifest right now. A stale one would write a row the cover never reads.
  const resolved = await resolveManualLine(id, label);
  if (!resolved) return NextResponse.json({ error: STALE_LABEL }, { status: 409 });
  const { line, normalized } = resolved;

  // fileName stands in for "this row holds bytes" — the five file columns are
  // written and cleared together, and selecting `file` itself would drag up to
  // 4 MB of blob out of Postgres to answer a null check.
  const existing = await db.styleManualTrimUpload.findUnique({
    where: { styleId_normalizedLabel: { styleId: id, normalizedLabel: normalized } },
    select: { id: true, fileName: true, sharepointItemId: true },
  });

  if (approved) {
    await db.styleManualTrimUpload.upsert({
      where: { styleId_normalizedLabel: { styleId: id, normalizedLabel: normalized } },
      create: {
        styleId: id,
        trimLabel: line.displayName,
        normalizedLabel: normalized,
        manualApprovedAt: new Date(),
        manualApprovedById: session.user.id,
      },
      update: {
        // The manifest's wording refreshes, in case Monday's changed only in
        // case or punctuation since the row was written.
        trimLabel: line.displayName,
        manualApprovedAt: new Date(),
        manualApprovedById: session.user.id,
        // The operator resolved by hand whatever the push failed on, so the
        // stale "couldn't reach the folder" hint would now be misleading.
        uploadError: null,
      },
      select: { id: true },
    });

    await auditLog(id, `manual trim approved by hand · ${line.displayName}`, {
      styleId: id,
      label: line.displayName,
      byUserId: session.user.id,
    });

    await scheduleCoverRegen(id);
    return NextResponse.json({ ok: true, approved: true, coverQueued: true });
  }

  if (!existing) return NextResponse.json({ ok: true, approved: false });

  // Bytes we hold (or a push we made) are the row's other reason to exist —
  // withdrawing the statement must not throw them away. Only a row that was
  // nothing but the statement goes.
  const isStatementOnly = existing.fileName === null && existing.sharepointItemId === null;
  if (isStatementOnly) {
    await db.styleManualTrimUpload.delete({ where: { id: existing.id } });
  } else {
    await db.styleManualTrimUpload.update({
      where: { id: existing.id },
      data: { manualApprovedAt: null, manualApprovedById: null },
    });
  }

  await auditLog(id, `manual trim approval withdrawn · ${line.displayName}`, {
    styleId: id,
    label: line.displayName,
    byUserId: session.user.id,
  });

  // Withdrawal moves the manifest too, and in the direction that matters most:
  // a cover still claiming an un-supplied line is approved is a promise to the
  // supplier that nobody is keeping.
  await scheduleCoverRegen(id);
  return NextResponse.json({ ok: true, approved: false, coverQueued: true });
}

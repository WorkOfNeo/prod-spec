import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { dispatchEmail } from "@/lib/email/dispatch";
import { combineSupplierRecipients } from "@/lib/suppliers/recipients";
import { loadContactEmailsBySupplier } from "@/lib/suppliers/contact-emails";
import { buildSupplierMessage } from "@/lib/publish/supplier-message";

export const runtime = "nodejs";
// One email per supplier, sequential — a 40-supplier batch takes a while.
export const maxDuration = 300;

// =====================================================
// Follow-up message to the suppliers a past send batch reached
// (/settings/approved → "Recent sends" → "Send email to suppliers").
//
// The correction channel. When a batch goes out wrong — as the 2026-08-13
// midnight batch did, mailing 43 suppliers about 607 below-cutoff orders — the
// only way to put it right was to open Outlook and write to each supplier by
// hand off a screenshot of the page. This sends one custom subject + body to
// exactly the suppliers on that batch, with {{supplier}} substituted per
// recipient.
//
// GET  — the recipient list for the dialog: every supplier on the batch, its
//        CURRENT resolved To/CC (re-resolved, not the batch's stored snapshot,
//        so a supplier whose email was fixed since is reachable now), and what
//        that supplier's original outcome was so the admin can see who actually
//        received the thing being corrected.
// POST — sends to the supplierIds the admin ticked. Never derives the recipient
//        set itself: an apology that reaches someone who never got the original
//        is its own small incident, so the choice stays explicit in the UI.
//
// ADMIN only, like every other action on this page.
// =====================================================

type PerSup = {
  supplierId: string | null;
  supplierName: string;
  email: string | null;
  status: string;
  outputCount?: number;
  styleCount?: number;
};

const BODY = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
  supplierIds: z.array(z.string().min(1)).min(1).max(500),
});

// Suppliers on a batch, in the order the batch recorded them. Rows without a
// supplierId (the "— no supplier linked" bucket) can't be emailed and are
// dropped here rather than surfacing as an un-tickable row.
function batchSuppliers(perSupplier: unknown): PerSup[] {
  const list = Array.isArray(perSupplier) ? (perSupplier as PerSup[]) : [];
  return list.filter((p) => typeof p?.supplierId === "string" && p.supplierId.length > 0);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const batch = await db.supplierSendBatch.findUnique({
    where: { id },
    select: { id: true, createdAt: true, source: true, status: true, outputCount: true, perSupplier: true },
  });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const per = batchSuppliers(batch.perSupplier);
  const ids = [...new Set(per.map((p) => p.supplierId as string))];
  const [suppliers, contactEmails] = await Promise.all([
    db.supplier.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true, contactEmail: true },
    }),
    loadContactEmailsBySupplier(ids),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const recipients = per.map((p) => {
    const supplier = supplierById.get(p.supplierId as string);
    const { to, cc } = combineSupplierRecipients(supplier, contactEmails.get(p.supplierId as string) ?? []);
    return {
      supplierId: p.supplierId as string,
      supplierName: supplier?.name ?? p.supplierName,
      to,
      cc,
      // What happened to this supplier in the batch being followed up on —
      // "SENT" means they really received it.
      originalStatus: p.status,
      outputCount: p.outputCount ?? 0,
    };
  });

  return NextResponse.json({
    batch: {
      id: batch.id,
      at: batch.createdAt.toISOString(),
      source: batch.source,
      status: batch.status,
      outputCount: batch.outputCount,
    },
    recipients,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { subject, body, supplierIds } = parsed.data;

  const batch = await db.supplierSendBatch.findUnique({
    where: { id },
    select: { id: true, perSupplier: true },
  });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  // Only suppliers that were actually on this batch — a stale dialog (or a
  // hand-rolled request) must not be able to turn "follow up on batch X" into a
  // mail-anyone endpoint.
  const onBatch = new Set(batchSuppliers(batch.perSupplier).map((p) => p.supplierId as string));
  const targets = [...new Set(supplierIds)].filter((sid) => onBatch.has(sid));
  if (targets.length === 0) {
    return NextResponse.json({ error: "None of those suppliers are on this batch" }, { status: 400 });
  }

  const [suppliers, contactEmails] = await Promise.all([
    db.supplier.findMany({
      where: { id: { in: targets } },
      select: { id: true, name: true, email: true, contactEmail: true },
    }),
    loadContactEmailsBySupplier(targets),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const results: Array<{
    supplierId: string;
    supplierName: string;
    to: string | null;
    status: string;
    error?: string | null;
  }> = [];
  let sentCount = 0;

  for (const supplierId of targets) {
    const supplier = supplierById.get(supplierId);
    const supplierName = supplier?.name ?? "supplier";
    const { to, cc } = combineSupplierRecipients(supplier, contactEmails.get(supplierId) ?? []);
    if (!to) {
      results.push({ supplierId, supplierName, to: null, status: "NO_EMAIL", error: "no supplier email on file" });
      continue;
    }

    const message = buildSupplierMessage({ supplierName, subject, body });
    try {
      const outcome = await dispatchEmail({
        type: "SUPPLIER_MESSAGE",
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      if (outcome.status === "SENT") sentCount += 1;
      results.push({ supplierId, supplierName, to, status: outcome.status, error: outcome.note });
    } catch (err) {
      // One supplier's failure must not abandon the other 39 mid-apology.
      results.push({ supplierId, supplierName, to, status: "FAILED", error: (err as Error).message });
    }
  }

  // Record that a follow-up went out, so the row can say so and a second send
  // to the same suppliers has to be a decision. Fail-soft + guarded: the
  // columns don't exist until `db:deploy` runs the migration, and a bookkeeping
  // write must never turn emails that already left into an error response.
  if (sentCount > 0) {
    await db.supplierSendBatch
      .update({ where: { id }, data: { followUpAt: new Date(), followUpCount: sentCount } })
      .catch((err) => {
        console.warn(`[supplier-message] follow-up stamp failed for batch ${id}:`, err);
      });
  }

  return NextResponse.json({ ok: true, attempted: targets.length, sentCount, results });
}

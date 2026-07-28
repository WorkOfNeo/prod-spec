import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { db } from "@/lib/db";
import { auditStyleDelivery, type StyleDeliveryAudit } from "@/lib/sharepoint/style-delivery-audit";
import { analyseStyleFilenames, describeSuggestion } from "@/lib/output-layouts/filename-collisions";
import { readEanResolveTrace } from "@/lib/po/ean-override-actions";
import type { CandidateToken } from "@/lib/output-layouts/filename-collision-rules";

export const runtime = "nodejs";
// Several sequential Graph reads (resolve → list folders → list files), and on
// POST a rename pass plus a push sweep.
export const maxDuration = 300;

// =====================================================
// Per-style delivery re-check.
//
//   GET  — read-only audit. Expands every queued output slot to its documents,
//          lists the real "APPROVED LAYOUTS" folder, and reports missing /
//          collided / stale / never-queued. Touches nothing.
//   POST — the same audit, then repair, in the order that makes each step
//          count:
//            1. reconcile  — capture approved slots the queue never got
//            2. rename     — fix files whose name drifted from the template
//                            (rename in place; no re-upload, no re-review)
//            3. re-arm     — flip rows whose file is genuinely gone to PENDING
//            4. push       — upload everything still pending
//          then re-audits and returns the before/after.
//
// Collisions are deliberately NOT repaired here. Several documents resolving to
// one file name cannot be fixed by uploading again — the second PUT overwrites
// the first exactly as before. The audit reports them with the token that would
// separate them; applying that is a template edit (apply-filename-fix).
// =====================================================

type CollisionFix = {
  spName: string;
  layoutId: string | null;
  layoutName: string | null;
  lost: number;
  docs: Array<{ name: string; variantKey: string }>;
  suggestion: CandidateToken[] | null;
  fix: string; // one sentence, already phrased against this layout's expression
  stylesUsingLayout: number; // blast radius of editing the shared template
};

// Enrich each collision with "which token would separate these" by re-resolving
// the layout's CURRENT expression against this style's live repetition rows —
// so a template that was just fixed reports as resolved without regenerating.
async function explainCollisions(
  styleId: string,
  audit: StyleDeliveryAudit,
): Promise<CollisionFix[]> {
  const out: CollisionFix[] = [];
  for (const c of audit.collisions) {
    let suggestion: CandidateToken[] | null = null;
    let fix =
      "These documents resolve to one file name, so only the last one survives the upload.";
    let layoutName: string | null = null;
    let stylesUsingLayout = 0;

    if (c.layoutId) {
      const [layout, usage] = await Promise.all([
        db.outputLayout.findUnique({ where: { id: c.layoutId }, select: { name: true } }),
        // Blast radius: distinct styles that have generated a document from
        // this layout. Editing the template changes the name for all of them.
        db.jobAsset
          .findMany({
            where: { variantKey: { startsWith: `layout:${c.layoutId}` } },
            select: { job: { select: { styleId: true } } },
            distinct: ["jobId"],
            take: 2000,
          })
          .then((rows) => new Set(rows.map((r) => r.job.styleId)).size)
          .catch(() => 0),
      ]);
      layoutName = layout?.name ?? null;
      stylesUsingLayout = usage;
      try {
        const analysis = await analyseStyleFilenames(styleId, c.layoutId);
        const group = analysis?.collisions[0];
        if (group) {
          suggestion = group.suggestion;
          fix = describeSuggestion(group.suggestion, analysis!.expression);
        } else if (analysis) {
          // Template already separates the rows — the collision is frozen into
          // names stamped at generation, which an approved output never
          // refreshes. "Repair & upload" re-derives them; no re-render, so the
          // approvals survive. This is the "renamed after approval" case.
          fix =
            "The file-name template already separates these — the documents just kept the names they were generated with. " +
            "“Repair & upload” re-names them from the current template and uploads them (no re-render, approvals kept).";
        }
      } catch {
        // Keep the generic sentence rather than failing the whole audit.
      }
    }

    out.push({
      spName: c.spName,
      layoutId: c.layoutId,
      layoutName,
      lost: c.lost,
      docs: c.docs.map((d) => ({ name: d.name, variantKey: d.variantKey })),
      suggestion,
      fix,
      stylesUsingLayout,
    });
  }
  return out;
}

// Compact last-EAN-resolve summary, carried alongside the delivery audit. A
// missing or wrong barcode is the most common upstream cause of an output that
// looks fine here but is wrong in the folder, so the two questions are worth
// answering on one screen: "are the files there" and "where did their barcodes
// come from". Full detail stays on the Details tab's EAN panel.
async function eanSummary(styleId: string) {
  const trace = await readEanResolveTrace(styleId);
  if (!trace) return null;
  return {
    at: trace.at,
    status: trace.status,
    source: trace.monday.mode === "fallback" ? "monday" : (trace.po?.eansFound ?? 0) > 0 ? "po" : "none",
    poOutcome: trace.po?.outcome ?? null,
    mondayOutcome: trace.monday.outcome,
    sizesMissingEan: trace.sizes.filter((s) => !s.ean13).map((s) => s.size),
    sizesMissingCarton: trace.sizes.filter((s) => !s.cartonEan).map((s) => s.size),
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires review access" }, { status: 403 });

  const { id } = await ctx.params;
  const audit = await auditStyleDelivery(id);
  const collisions = await explainCollisions(id, audit);
  return NextResponse.json(
    { ok: true, audit, collisions, ean: await eanSummary(id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires review access" }, { status: 403 });

  const { id } = await ctx.params;
  const before = await auditStyleDelivery(id);

  // Nothing to act on — don't spend Graph writes proving it.
  if (before.status === "disabled" || before.status === "unresolved" || before.status === "ambiguous") {
    return NextResponse.json({ ok: true, acted: false, before, after: before, collisions: [], ean: await eanSummary(id) });
  }

  const actions: string[] = [];

  // 1. Capture approved slots the queue never got (targeted reconcile bypasses
  //    the "already captured" exclusion that leaves half-captured styles stuck).
  if (before.unqueued.length > 0) {
    try {
      const { reconcileSupplierSendQueue } = await import("@/lib/publish/supplier-send-queue");
      const r = await reconcileSupplierSendQueue({ styleIds: [id] });
      if (r.outputsEnqueued > 0) actions.push(`queued ${r.outputsEnqueued} previously-uncaptured output(s)`);
    } catch (err) {
      console.warn(`[delivery-audit] reconcile failed for ${id}:`, err);
    }
  }

  // 2. Rename drifted files in place, where the mapping is 1:1. An approved
  //    output is never regenerated, so a template edit after approval never
  //    reaches SharePoint on its own; this closes that gap with a Graph PATCH —
  //    no re-upload, no re-review. It works per output SLOT, so it cannot help
  //    a split slot whose documents share a name (step 3 does that).
  try {
    const { fixOutputFileNames } = await import("@/lib/sharepoint/fix-output-filenames");
    const fixed = await fixOutputFileNames({ styleIds: [id] });
    if (fixed.renamed > 0 || fixed.deletedStale > 0) {
      actions.push(
        `renamed ${fixed.renamed} file(s) in place` +
          (fixed.deletedStale > 0 ? `, removed ${fixed.deletedStale} stale duplicate(s)` : ""),
      );
    }
  } catch (err) {
    console.warn(`[delivery-audit] filename fix failed for ${id}:`, err);
  }

  // 3. Re-derive EVERY document's file name from its layout's CURRENT template.
  //    This is the fix for "the output was renamed after it was approved": the
  //    name is stamped on the JobAsset at generation and an approved output is
  //    never re-generated, so the new template never reaches the stored names —
  //    and a slot whose documents used to collide keeps ONE name forever. Only
  //    names change; the PDFs and their approvals are untouched.
  try {
    const { restampFileNamesForStyle } = await import("@/lib/sharepoint/restamp-file-names");
    const restamp = await restampFileNamesForStyle({ styleId: id });
    if (restamp.changed > 0) {
      actions.push(`re-named ${restamp.changed} document(s) from the current template`);
    }
  } catch (err) {
    console.warn(`[delivery-audit] restamp failed for ${id}:`, err);
  }

  // 4. Re-audit: steps 2–3 changed what we expect to find, so the set of
  //    genuinely-absent files must be recomputed rather than reused from
  //    `before` (where three colliding documents looked delivered).
  const midAudit = await auditStyleDelivery(id);

  // 5. Re-arm rows whose file is absent. Collisions are excluded by
  //    construction: a collided document's NAME is present in the folder, so it
  //    never appears in `missing` — which is what keeps this from churning.
  const missingBases = [...new Set(midAudit.missing.map((d) => d.baseKey))];
  if (missingBases.length > 0) {
    const rearmed = await db.supplierSendQueueItem
      .updateMany({
        where: { styleId: id, variantKey: { in: missingBases } },
        data: {
          sharePointStatus: "PENDING",
          pushAttempts: 0,
          sharePointUrl: null,
          sharePointVerifiedAt: null,
          queuedAt: new Date(),
        },
      })
      .catch(() => ({ count: 0 }));
    if (rearmed.count > 0) actions.push(`re-armed ${rearmed.count} output slot(s)`);
  }

  // 6. Push everything still pending for this style.
  try {
    const { pushQueuedSupplierUploads } = await import("@/lib/sharepoint/push-queued-to-supplier");
    const sweep = await pushQueuedSupplierUploads({
      styleIds: [id],
      includeFloated: true,
      recordRunAs: "delivery-recheck",
    });
    if (sweep.uploaded > 0) actions.push(`uploaded ${sweep.uploaded} output slot(s)`);
    if (sweep.failed > 0) actions.push(`${sweep.failed} push(es) failed`);
  } catch (err) {
    console.warn(`[delivery-audit] push failed for ${id}:`, err);
  }

  const after = await auditStyleDelivery(id);
  const collisions = await explainCollisions(id, after);
  return NextResponse.json({
    ok: true,
    acted: true,
    actions,
    before,
    after,
    collisions,
    ean: await eanSummary(id),
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { db } from "@/lib/db";
import { layoutSettings, parseLayoutDef } from "@/lib/output-layouts/schema";
import { analyseStyleFilenames } from "@/lib/output-layouts/filename-collisions";
import type { CandidateToken } from "@/lib/output-layouts/filename-collision-rules";
import { restampFileNamesForStyle } from "@/lib/sharepoint/restamp-file-names";

export const runtime = "nodejs";
export const maxDuration = 300;

// =====================================================
// One-click file-name collision fix (style page → Delivery check).
//
// Appends the token that actually separates the colliding documents to the
// layout's file-name template, then re-stamps THIS style's existing documents
// from the new template and re-pushes — no re-render, so the approvals survive.
//
// ADMIN-only, and deliberately so: the template is shared by every style using
// the layout, and this endpoint reports that blast radius back so the caller
// can show it before and after.
//
// The token is resolved SERVER-SIDE from a live re-analysis; a client-supplied
// token list is only accepted as a filter over what the analysis suggests, so a
// stale page can never write a token that doesn't separate anything.
// =====================================================

const TOKEN_TEXT: Record<CandidateToken, string> = {
  size: "{{size}}",
  colourName: "{{colourName}}",
  ean13: "{{ean13}}",
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id: layoutId } = await ctx.params;
  let styleId = "";
  let dryRun = false;
  try {
    const body = (await req.json()) as { styleId?: unknown; dryRun?: unknown };
    if (typeof body?.styleId === "string") styleId = body.styleId;
    dryRun = body?.dryRun === true;
  } catch {
    // handled by the guard below
  }
  if (!styleId) return NextResponse.json({ error: "styleId is required" }, { status: 400 });

  const layout = await db.outputLayout.findUnique({
    where: { id: layoutId },
    select: { id: true, name: true, definition: true },
  });
  if (!layout) return NextResponse.json({ error: "Layout not found" }, { status: 404 });

  // What does this layout's CURRENT template do to this style's rows?
  const analysis = await analyseStyleFilenames(styleId, layoutId);
  if (!analysis) {
    return NextResponse.json(
      { error: "This layout doesn't split per EAN or has no custom file name — nothing to fix." },
      { status: 400 },
    );
  }
  if (analysis.collisions.length === 0) {
    return NextResponse.json({
      ok: true,
      changed: false,
      message:
        "The file-name template already separates every document — re-run this style to replace files generated under the old template.",
      expression: analysis.expression,
    });
  }

  const suggestion = analysis.collisions[0].suggestion;
  if (!suggestion) {
    return NextResponse.json(
      {
        error:
          "No token can separate these documents — they are identical in size, colour and EAN. That's a PO/EAN data problem, not a template one.",
      },
      { status: 409 },
    );
  }

  // Only the tokens not already present need appending.
  const missing = suggestion.filter(
    (t) => !new RegExp(`\\{\\{\\s*${t}\\s*\\}\\}`).test(analysis.expression),
  );
  if (missing.length === 0) {
    return NextResponse.json(
      {
        error:
          "Every token that would separate these is already in the file name, but the rows still resolve to the same values — check the style's EAN rows.",
      },
      { status: 409 },
    );
  }

  const nextExpression = `${analysis.expression.trimEnd()}-${missing.map((t) => TOKEN_TEXT[t]).join("-")}`;

  // Blast radius: distinct styles that have generated a document from this
  // layout. They keep their current names until each is re-checked or re-run —
  // this endpoint only re-stamps the style it was called for.
  const otherStyles = await db.jobAsset
    .findMany({
      where: { variantKey: { startsWith: `layout:${layoutId}` } },
      select: { job: { select: { styleId: true } } },
      take: 5000,
    })
    .then((rows) => new Set(rows.map((r) => r.job.styleId)))
    .catch(() => new Set<string>());
  otherStyles.delete(styleId);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      changed: false,
      dryRun: true,
      layoutName: layout.name,
      expression: analysis.expression,
      nextExpression,
      lost: analysis.collisions.reduce((n, c) => n + c.rows.length - 1, 0),
      otherStylesAffected: otherStyles.size,
    });
  }

  // Write the new expression, preserving the rest of the definition verbatim.
  const raw = (layout.definition ?? {}) as Record<string, unknown>;
  const settings = { ...layoutSettings(parseLayoutDef(layout.definition)), fileName: nextExpression };
  const nextDefinition = { ...raw, settings };
  // Validate before persisting — a definition that won't parse would break
  // every render using this layout.
  try {
    parseLayoutDef(nextDefinition);
  } catch (err) {
    return NextResponse.json(
      { error: `New definition failed validation: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  await db.outputLayout.update({ where: { id: layoutId }, data: { definition: nextDefinition } });

  // Confirm the edit actually separated them rather than assuming it did.
  const after = await analyseStyleFilenames(styleId, layoutId);
  const stillColliding = after?.collisions.length ?? 0;

  // Re-stamp THIS style's existing documents from the new template. No
  // re-render: the PDFs were always right, only their names collided — so the
  // approvals (and the review history) survive intact.
  const restamp = await restampFileNamesForStyle({ styleId, layoutId });

  // Re-arm the affected slots and push, so the newly-named files land now.
  let uploaded = 0;
  if (restamp.changed > 0 && stillColliding === 0) {
    try {
      await db.supplierSendQueueItem.updateMany({
        where: { styleId, variantKey: `layout:${layoutId}` },
        data: {
          sharePointStatus: "PENDING",
          pushAttempts: 0,
          sharePointUrl: null,
          sharePointVerifiedAt: null,
          queuedAt: new Date(),
        },
      });
      const { pushQueuedSupplierUploads } = await import("@/lib/sharepoint/push-queued-to-supplier");
      const sweep = await pushQueuedSupplierUploads({
        styleIds: [styleId],
        includeFloated: true,
        recordRunAs: "filename-fix",
      });
      uploaded = sweep.uploaded;
    } catch (err) {
      console.warn(`[apply-filename-fix] push failed for ${styleId}:`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    changed: true,
    layoutName: layout.name,
    expression: analysis.expression,
    nextExpression,
    stillColliding,
    renamed: restamp.changed,
    renamedItems: restamp.items,
    skipped: restamp.skips,
    uploaded,
    otherStylesAffected: otherStyles.size,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import {
  reconcileStyleFolder,
  rearmMissingUploads,
  adoptRenamedFile,
  ReconcileApplyError,
} from "@/lib/sharepoint/reconcile-folder";

export const runtime = "nodejs";
// A handful of sequential Graph reads (resolve link → list the supplier root's
// folders → find the leaf → list its files), plus the current-outputs walk.
// Same headroom as the supplier-folder file count, which does the same chain.
export const maxDuration = 60;

// =====================================================
// Per-style supplier-folder reconcile.
//
//   GET  → run the bidirectional diff. STRICTLY read-only; it never mutates,
//          so a user can press "Re-check" as often as they like.
//   POST → apply exactly ONE named, itemised action. There is deliberately no
//          "fix everything": the two repairs have opposite effects on a
//          hand-renamed file (re-arm re-uploads and leaves BOTH copies; adopt
//          renames the human's copy so exactly one remains), and only a person
//          looking at the diff can say which is right.
//
// Role gate mirrors the closest sibling, POST /api/admin/styles/[id]/rerun:
// session or 401, canReview or 403. Reviewers already re-run and approve
// outputs, and both actions here are narrower than that — a re-arm only asks
// the existing upload sweep to push an already-approved file to the folder it
// was always destined for, and an adopt renames a file to the name the config
// already says it should have. `params` is a Promise and must be awaited
// (Next.js 16 removed the synchronous access v15 still allowed).
// =====================================================

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const result = await reconcileStyleFolder(id);
  if (result.state === "style-not-found") {
    return NextResponse.json({ error: "Style not found" }, { status: 404 });
  }

  // no-store: this is a live folder snapshot. A cached reconcile is worse than
  // no reconcile — it would show drift that has already been repaired (or,
  // worse, hide drift that just appeared).
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

type ApplyBody = {
  action?: unknown;
  queueItemIds?: unknown; // action: "rearm-missing"
  itemId?: unknown; // action: "adopt-renamed"
  toFileName?: unknown; // action: "adopt-renamed"
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as ApplyBody;
  const action = typeof body.action === "string" ? body.action : "";

  try {
    // ---- Re-arm named queue rows so the upload sweep re-uploads them.
    // The ids are validated against THIS style inside the lib, so an id
    // belonging to another style can't be smuggled through the body.
    if (action === "rearm-missing") {
      const queueItemIds = Array.isArray(body.queueItemIds)
        ? body.queueItemIds.filter((x): x is string => typeof x === "string")
        : [];
      if (queueItemIds.length === 0) {
        return NextResponse.json(
          { error: "queueItemIds is required — pick the outputs to re-upload (this action is never a blanket fix)." },
          { status: 400 },
        );
      }
      const result = await rearmMissingUploads({ styleId: id, queueItemIds, userId: session.user.id });
      if (result.rearmed === 0) {
        return NextResponse.json(
          { error: "None of those queue rows belong to this style any more — re-check and try again." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, action, ...result });
    }

    // ---- Adopt one hand-renamed file back onto its expected name. Both
    // arguments are re-validated against a fresh diff inside the lib before
    // anything is renamed.
    if (action === "adopt-renamed") {
      const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
      const toFileName = typeof body.toFileName === "string" ? body.toFileName.trim() : "";
      if (!itemId || !toFileName) {
        return NextResponse.json(
          { error: "itemId and toFileName are both required — name the exact file and the exact target name." },
          { status: 400 },
        );
      }
      const result = await adoptRenamedFile({ styleId: id, itemId, toFileName, userId: session.user.id });
      return NextResponse.json({ ok: true, action, ...result });
    }

    return NextResponse.json(
      { error: `Unknown action “${action}” — expected "rearm-missing" or "adopt-renamed".` },
      { status: 400 },
    );
  } catch (err) {
    // The lib's refusals are the USER's to resolve (folder moved, file already
    // re-uploaded, write not granted) rather than bugs — keep their status.
    if (err instanceof ReconcileApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(`[folder-reconcile] ${action} failed for style ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Folder reconcile action failed" },
      { status: 500 },
    );
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { pickStyleNumberMatch } from "@/lib/pdf/style-number-match";

export const runtime = "nodejs";
// One cover render (Chromium) plus a SharePoint round trip for one style.
export const maxDuration = 300;

// =====================================================
// "Regenerate one style" — the escape hatch beside the General information
// editor. A person types a style NUMBER; this rebuilds that one style's cover
// PDF (which is where the General information pages print) and pushes it back
// into the supplier's folder, so the file the supplier opens today matches the
// text that was just saved.
//
// WHY IT EXISTS. Saving General information only affects bundles generated
// FROM NOW ON — the runner re-renders a cover only when a run produces ≥1
// output, and a fully-approved style settles without rendering at all, so
// existing covers are frozen on the text they were built with. The bulk sweep
// beside this one fixes that for a whole prod spec, which is the right tool
// after a wording change everybody should see and the wrong one when a single
// order needs correcting: it walks every style under the spec and re-pushes
// each delivered cover. This is the narrow instrument for "just fix that one".
//
// BOTH HALVES OR NEITHER. Regenerating without re-uploading would leave the
// supplier looking at the old PDF while the app insists it is fixed — the
// worst of the three outcomes, because it looks done. So the run does the
// rebuild AND the push, and reports each independently: what was regenerated,
// what was queued, what actually reached SharePoint, and which folder it landed
// in. A push that fails is reported as a failure, not swallowed.
//
//   POST { mode: "resolve", styleNumber }
//     → { matches: [{ styleId, styleName, … , inThisSpec, hasCover, … }],
//         matchedExactly, ambiguous }
//   POST { mode: "run", styleId, notifySupplier? }
//     → { styleName, refreshed, requeue, pushed, pushFailed, folderUrl, … }
//
// ============ WHY NOT THE FULL ProdSpec PATCH (the constraint) ============
// This sits under .../general-info/ deliberately. The full
// /api/admin/prod-specs/<id> PATCH AUTO-ACTIVATES: its `hasOtherChange` counts
// generalInfoMd (among name, outputs, logo, page settings…), so any save that
// carries prose flips a draft spec's `active` to true — which is what makes a
// spec eligible for Job auto-enqueue. A reviewer regenerating one style's cover
// on a half-configured spec would arm the whole spec for generation as a side
// effect. That is exactly why the sibling general-info route exists, and the
// same reasoning binds here.
//
// This route therefore never PATCHes the ProdSpec at all. It reads
// generalInfoMd's blast radius (which styles belong to the spec) and writes
// only JobAsset.pdf + the supplier queue row. It touches no ProdSpec column,
// so `active` cannot move. tests/general-info-single-regen.test.ts pins that:
// it asserts db.prodSpec.update is never called.
//
// SCOPE. Strictly one style, and only a style belonging to THIS prod spec. A
// cover renders its style's present-day spec's General information, so
// regenerating a style from another spec would print another spec's text —
// correct, but never what someone on this tab meant. Refused with a message
// naming the spec it does belong to, rather than quietly doing the wrong thing.
// =====================================================

// Same gate as the sibling general-info route: ADMIN + REVIEWER via
// getSessionWithRole + canReview, so the predicate stays pure and the gate is
// drivable end-to-end by mocking only the session. Reviewers own this prose, so
// an edit they can make but not publish would only be half a handover.
type Gate = { ok: true; userId: string } | { ok: false; res: NextResponse };

async function gate(): Promise<Gate> {
  const { session, role } = await getSessionWithRole();
  if (!session) return { ok: false, res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  if (!canReview(role)) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 }),
    };
  }
  return { ok: true, userId: session.user.id };
}

const RESOLVE = z.object({
  mode: z.literal("resolve"),
  styleNumber: z.string().min(1).max(64),
});
const RUN = z.object({
  mode: z.literal("run"),
  // An id, not a number: `resolve` already turned the typed text into a
  // specific row (and made the person choose when several matched). Re-running
  // the text match here would let an ambiguous entry resolve differently
  // between the confirm and the act.
  styleId: z.string().min(1),
  // Default FALSE, matching the bulk sweep's reasoning: the corrected file
  // belongs in the supplier's folder either way, but an email is a separate
  // decision the operator makes deliberately.
  notifySupplier: z.boolean().default(false),
});
const BODY = z.discriminatedUnion("mode", [RESOLVE, RUN]);

// Candidate shape the picker renders. Everything here is decision-relevant:
// with several rows sharing a style number, the PO and colour are what tell
// them apart.
type Candidate = {
  styleId: string;
  styleName: string;
  customerName: string | null;
  supplierName: string | null;
  poNumber: string | null;
  status: string;
  // false ⇒ belongs to a different prod spec; `run` refuses it.
  inThisSpec: boolean;
  prodSpecName: string | null;
  // false ⇒ never generated a bundle, so there is no cover to rebuild.
  hasCover: boolean;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await gate();
  if (!auth.ok) return auth.res;

  const { id: prodSpecId } = await ctx.params;

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const prodSpec = await db.prodSpec.findUnique({
    where: { id: prodSpecId },
    select: { id: true, name: true },
  });
  if (!prodSpec) return NextResponse.json({ error: "Prod spec not found" }, { status: 404 });

  return parsed.data.mode === "resolve"
    ? resolve(parsed.data.styleNumber, prodSpec)
    : run(parsed.data.styleId, parsed.data.notifySupplier, prodSpec, auth.userId);
}

// ── resolve: say what WILL happen, before anything happens ──────────────────
async function resolve(styleNumber: string, prodSpec: { id: string; name: string }) {
  const query = styleNumber.trim();

  // Deliberately NOT scoped to this prod spec. A style number that belongs to
  // another spec must come back as a named refusal ("that one is under <spec>")
  // rather than as "no style matches" — the second sends someone hunting for a
  // typo that isn't there. Bounded so a one-character entry can't drag the
  // estate back through the contains tier.
  const rows = await db.style.findMany({
    where: { name: { contains: query, mode: "insensitive" }, deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      poNumber: true,
      prodSpecId: true,
      customer: { select: { name: true } },
      supplier: { select: { name: true } },
      prodSpec: { select: { name: true } },
    },
    orderBy: [{ name: "asc" }, { updatedAt: "desc" }],
    take: 25,
  });

  // The exact-beats-contains + never-guess-between-several decision. See
  // style-number-match.ts: in this data a style number is NOT unique (one
  // Pre-Order row per PO, two colourways per number), so several matches is
  // ordinary and the person has to choose.
  const match = pickStyleNumberMatch(rows, query);
  if (match.kind === "none") {
    return NextResponse.json({ matches: [], matchedExactly: false, ambiguous: false });
  }
  const picked = match.kind === "one" ? [match.row] : match.rows;

  // Which of these has a cover to rebuild at all. One query for the set rather
  // than one per candidate.
  const withCover = new Set(
    (
      await db.job.findMany({
        where: {
          styleId: { in: picked.map((r) => r.id) },
          status: { not: "FAILED" },
          assets: { some: { variantKey: COVER_VARIANT_KEY } },
        },
        select: { styleId: true },
        distinct: ["styleId"],
      })
    ).map((j) => j.styleId),
  );

  const matches: Candidate[] = picked.map((r) => ({
    styleId: r.id,
    styleName: r.name,
    customerName: r.customer?.name?.trim() || null,
    supplierName: r.supplier?.name?.trim() || null,
    poNumber: r.poNumber,
    status: r.status,
    inThisSpec: r.prodSpecId === prodSpec.id,
    prodSpecName: r.prodSpec?.name?.trim() || null,
    hasCover: withCover.has(r.id),
  }));

  return NextResponse.json({
    matches,
    matchedExactly: match.matchedExactly,
    ambiguous: match.kind === "ambiguous",
  });
}

// ── run: rebuild the cover, then put it back in the supplier's folder ───────
async function run(
  styleId: string,
  notifySupplier: boolean,
  prodSpec: { id: string; name: string },
  userId: string,
) {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      id: true,
      name: true,
      prodSpecId: true,
      supplierFolderUrl: true,
      prodSpec: { select: { name: true } },
    },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // The scope guard. Re-checked here and not merely at resolve: `run` takes an
  // id straight from the client, and the whole point of this control is that it
  // touches one style and no other.
  if (style.prodSpecId !== prodSpec.id) {
    return NextResponse.json(
      {
        error:
          `${style.name} belongs to ${style.prodSpec?.name ?? "another client / business area"}, ` +
          `not ${prodSpec.name}. Its cover prints that spec's General information — ` +
          `switch to it above to regenerate this style.`,
      },
      { status: 409 },
    );
  }

  // Lazy, exactly as the cover-sample route does it: the render chain pulls in
  // puppeteer, and none of the validation above needs it. A refused request
  // stays a cheap 404/409 instead of a cold start behind the whole PDF stack.
  const { refreshStyleCoverAsset } = await import("@/lib/pdf/refresh-cover");
  const { enqueueCoverForSupplier } = await import("@/lib/publish/requeue-cover");

  // No onlyWhenPending / onlyWhenChanged. Both exist to bound a sweep over
  // hundreds of styles; here a person typed this style number on purpose, and
  // "skipped — nothing changed" is the exact useless answer this control was
  // built to avoid. stampManifest keeps the fingerprint honest anyway, so the
  // rebuild doesn't leave the next bulk sweep re-pushing this cover for
  // nothing — see refresh-cover.ts.
  const refresh = await refreshStyleCoverAsset(style.id, { stampManifest: true });

  if (refresh.status !== "refreshed") {
    // "no-cover" is the common one and is not an error: the style has never
    // generated a bundle, so there is nothing to rebuild — and it will carry
    // the current text the first time it does.
    return NextResponse.json({
      styleName: style.name,
      refreshed: false,
      reason: refresh.status,
      message:
        refresh.status === "no-cover"
          ? `${style.name} has never generated a bundle, so there is no cover to rebuild. ` +
            `It will include the current General information the first time it generates.`
          : refresh.status === "error"
            ? `Could not rebuild ${style.name}'s cover: ${refresh.error}`
            : `Nothing to do for ${style.name}.`,
      requeue: null,
      pushed: 0,
      pushFailed: 0,
      folderUrl: null,
    });
  }

  // Arm the supplier queue row for this ONE style. Gated inside on a real
  // delivery target, ≥1 generated output and the supplier-send PO cutoff — the
  // outcome string says which gate stopped it, so "regenerated but not pushed"
  // is always explained rather than left as a silent half-success.
  let requeue: string;
  try {
    requeue = await enqueueCoverForSupplier(style.id, refresh.coverAssetId, { notifySupplier });
  } catch (err) {
    requeue = "error";
    console.warn(`[gi-single-regen] requeue failed for ${style.id}:`, err);
  }

  // Push now rather than waiting for the recurring sweep — the person is
  // standing here asking for the supplier's copy to be corrected. Scoped to
  // this one style id, so nothing else in the queue rides along. Same path
  // publish uses, so the supplier-send master switch and the PO cutoff still
  // apply (it returns 0 uploaded when batch-send is off, and the armed row
  // waits for the switch).
  let pushed = 0;
  let pushFailed = 0;
  let pushError: string | null = null;
  if (requeue === "queued") {
    try {
      const { pushQueuedSupplierUploads } = await import("@/lib/sharepoint/push-queued-to-supplier");
      const sweep = await pushQueuedSupplierUploads({
        styleIds: [style.id],
        recordRunAs: "gi-single-regen",
      });
      pushed = sweep.uploaded;
      pushFailed = sweep.failed;
      pushError = sweep.failures[0]?.message ?? null;
    } catch (err) {
      pushFailed = 1;
      pushError = (err as Error).message;
      console.warn(`[gi-single-regen] SharePoint push failed for ${style.id}:`, err);
    }
  }

  // Where it actually landed, read back from the queue row the push just
  // stamped — "regenerated and pushed" is only a real answer if it can name the
  // folder. Falls back to the style's remembered supplier folder.
  const queueRow = await db.supplierSendQueueItem
    .findUnique({
      where: { styleId_variantKey: { styleId: style.id, variantKey: COVER_VARIANT_KEY } },
      select: { sharePointStatus: true, sharePointFolderUrl: true, sharePointError: true },
    })
    .catch(() => null);

  await db.log
    .create({
      data: {
        level: "INFO",
        message:
          `general information: single-style cover regenerate for ${style.name} ` +
          `(${style.id}) under prod spec ${prodSpec.name} by user ${userId} — ` +
          `requeue=${requeue} pushed=${pushed} failed=${pushFailed} ` +
          `notify=${notifySupplier ? "yes" : "no"}`,
      },
    })
    .catch(() => {});

  return NextResponse.json({
    styleName: style.name,
    refreshed: true,
    reason: refresh.status,
    requeue,
    pushed,
    pushFailed,
    pushError,
    notifySupplier,
    sharePointStatus: queueRow?.sharePointStatus ?? null,
    folderUrl: queueRow?.sharePointFolderUrl ?? style.supplierFolderUrl ?? null,
    sharePointError: queueRow?.sharePointError ?? null,
  });
}

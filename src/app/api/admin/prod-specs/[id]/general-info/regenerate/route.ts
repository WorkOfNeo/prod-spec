import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { pickStyleNumberMatch } from "@/lib/pdf/style-number-match";

export const runtime = "nodejs";
// A Chromium cover render plus a SharePoint round trip PER STYLE, run one after
// another. MAX_STYLES_PER_RUN is what keeps a whole list inside this window.
export const maxDuration = 300;

// =====================================================
// "Regenerate a style" — the escape hatch beside the General information
// editor. A person types a style NUMBER; this rebuilds the cover PDF of every
// style carrying that number (which is where the General information pages
// print) and pushes each back into its supplier's folder, so the files the
// suppliers open today match the text that was just saved.
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
// ALL OF THEM, NOT ONE OF THEM. That style number matches several rows is the
// rule here, not the exception, so "found 4, fixed 1" would leave three
// suppliers on the old PDF while the app read as done. `resolve` names every
// match so the choice is informed; `run` then works through the whole list.
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
//   POST { mode: "run", styleIds: [...], notifySupplier? }
//     → { results: [{ styleName, refreshed, requeue, pushed, folderUrl, … }],
//         summary: { total, refreshed, pushed, failed, … } }
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
// so `active` cannot move. tests/general-info-regen.test.ts pins that:
// it asserts db.prodSpec.update is never called.
//
// ============ SCOPE: EVERY MATCH, EACH AGAINST ITS OWN SPEC ============
// A style number resolves to several rows as a matter of course (one Pre-Order
// row per PO, two colourways per number), and someone correcting an order means
// all of them — the same garment, the same wrong text. So `run` takes the whole
// candidate list and works through it, rather than making someone type the same
// number once per row and hope they got them all.
//
// It is a LOOP, not a batch: each style is rebuilt, armed and pushed on its own,
// inside its own try, and reported on its own. One style's render blowing up or
// its supplier folder being unreachable must not cost the other four their fix,
// and — the sharper half — five styles where one failed must never come back
// reading as one success. Hence a per-style row for every id plus a counted
// summary; the client has no reason to infer either.
//
// EACH AGAINST ITS OWN SPEC. This deliberately does NOT require the styles to
// belong to the prod spec whose editor is open. It used to: a foreign style was
// refused with a 409, on the reasoning that its cover prints ANOTHER spec's
// General information. That reasoning is right and the refusal was the wrong
// remedy — the number a person types is the number they want fixed, and which
// client's tab they happen to have open is an accident of navigation.
//
// The correctness it was protecting is structural, not a matter of asking
// nicely: refreshStyleCoverAsset(styleId) → buildStyleCoverPdf(jobId) loads
// `style.prodSpec.generalInfoMd` from the STYLE's own row. Nothing about the
// open spec is passed down — this route never even selects generalInfoMd — so a
// style belonging elsewhere renders its own spec's text and cannot render this
// one's. The route resolves each style's spec only to NAME it in the result, so
// a cross-spec regenerate is visible rather than silent.
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

// Same ceiling `resolve` returns, so the act can cover everything the person was
// shown and can never exceed it. A one-character entry that dredges up 25 rows
// is bounded here as well as there.
const MAX_STYLES_PER_RUN = 25;

const RESOLVE = z.object({
  mode: z.literal("resolve"),
  styleNumber: z.string().min(1).max(64),
});
const RUN = z.object({
  mode: z.literal("run"),
  // Ids, not the number: `resolve` already turned the typed text into specific
  // rows and put them on screen. Re-running the text match here would let the
  // set shift between the confirm and the act — the person approved a named
  // list of orders, and that list is what gets acted on.
  styleIds: z.array(z.string().min(1)).min(1).max(MAX_STYLES_PER_RUN),
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

  // Id and name ONLY. Not generalInfoMd: the covers render each style's own
  // spec's prose (see the scope note above), so the open spec's text has no
  // business being in scope here — the narrow select is what makes that
  // impossible rather than merely intended. The name is for labelling results.
  const prodSpec = await db.prodSpec.findUnique({
    where: { id: prodSpecId },
    select: { id: true, name: true },
  });
  if (!prodSpec) return NextResponse.json({ error: "Prod spec not found" }, { status: 404 });

  return parsed.data.mode === "resolve"
    ? resolve(parsed.data.styleNumber, prodSpec)
    : run(parsed.data.styleIds, parsed.data.notifySupplier, prodSpec, auth.userId);
}

// ── resolve: say what WILL happen, before anything happens ──────────────────
async function resolve(styleNumber: string, prodSpec: { id: string; name: string }) {
  const query = styleNumber.trim();

  // Deliberately NOT scoped to this prod spec — and since `run` no longer
  // refuses a foreign style, this is the search that finds it rather than a
  // search that only exists to explain a refusal. Someone on any client's tab
  // types a number and gets the orders carrying it, each labelled with the spec
  // whose General information its cover prints. Bounded so a one-character
  // entry can't drag the estate back through the contains tier.
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

// ── run: rebuild each cover, then put each back in its supplier's folder ────

// One style's outcome. Deliberately flat and per-style: the caller renders one
// row per style and counts them, and nothing about style N's fate can be
// inferred from style N-1's.
type StyleRunResult = {
  styleId: string;
  styleName: string | null;
  // The spec whose General information this cover printed — the style's OWN,
  // which is not necessarily the one whose editor is open. Named so a
  // cross-spec regenerate is visible in the report rather than silent.
  prodSpecName: string | null;
  inThisSpec: boolean;
  refreshed: boolean;
  // A single word for what became of this style, so the client never has to
  // reconstruct it from three numbers:
  //   pushed        rebuilt and delivered
  //   not-pushed    rebuilt, but a gate (no supplier, below cutoff, batch-send
  //                 off) meant nothing was delivered — `requeue` says which
  //   push-failed   rebuilt, delivery ATTEMPTED and failed. Not a success.
  //   no-cover      never generated a bundle; there is nothing to rebuild
  //   not-found     the id no longer resolves to a style
  //   error         the rebuild itself failed
  outcome: "pushed" | "not-pushed" | "push-failed" | "no-cover" | "not-found" | "error";
  reason: string | null;
  message: string | null;
  requeue: string | null;
  pushed: number;
  pushFailed: number;
  pushError: string | null;
  sharePointStatus: string | null;
  folderUrl: string | null;
  sharePointError: string | null;
};

type RunStyle = {
  id: string;
  name: string;
  prodSpecId: string | null;
  supplierFolderUrl: string | null;
  prodSpec: { name: string } | null;
};

async function run(
  styleIds: string[],
  notifySupplier: boolean,
  prodSpec: { id: string; name: string },
  userId: string,
) {
  // The same id twice would rebuild and re-push the same cover twice; the set
  // is what was meant either way.
  const wanted = [...new Set(styleIds)];

  const rows = (await db.style.findMany({
    // deletedAt: null to match `resolve`. An id that went soft-deleted between
    // the search and the button falls through to "no longer exists" rather than
    // quietly re-publishing a withdrawn order's cover.
    where: { id: { in: wanted }, deletedAt: null },
    select: {
      id: true,
      name: true,
      prodSpecId: true,
      supplierFolderUrl: true,
      // Read to NAME the spec in the report. The cover's General information
      // comes from the style's own row inside buildStyleCoverPdf — nothing
      // here is passed into the render.
      prodSpec: { select: { name: true } },
    },
  })) as RunStyle[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Every requested id resolved to nothing: the client is out of step with the
  // database, which is a request-level error rather than N per-style ones.
  if (rows.length === 0) {
    return NextResponse.json({ error: "Style not found" }, { status: 404 });
  }

  // SEQUENTIAL, and on purpose. Each pass is a Chromium render plus a Graph
  // round trip; firing five at once would contend for the same browser pool
  // and interleave the SharePoint writes for no gain a person waiting on this
  // would notice. Bounded by MAX_STYLES_PER_RUN, which is what keeps the total
  // inside maxDuration.
  const results: StyleRunResult[] = [];
  for (const styleId of wanted) {
    const style = byId.get(styleId);
    if (!style) {
      results.push({
        ...blank(styleId),
        outcome: "not-found",
        message: "This style no longer exists — it may have been deleted since the search.",
      });
      continue;
    }
    // One style's failure is its own. Anything the per-style path throws is
    // recorded against that style and the loop carries on to the rest; the
    // whole point of acting on the list is that it does not abandon four
    // orders because the fifth misbehaved.
    try {
      results.push(await runOne(style, notifySupplier, prodSpec));
    } catch (err) {
      console.warn(`[gi-regen] ${styleId} failed:`, err);
      results.push({
        ...blank(styleId),
        styleName: style.name,
        prodSpecName: style.prodSpec?.name?.trim() ?? null,
        inThisSpec: style.prodSpecId === prodSpec.id,
        outcome: "error",
        message: `Could not rebuild ${style.name}'s cover: ${(err as Error).message}`,
      });
    }
  }

  // Counted here rather than left to the client: "5 styles, 4 delivered, 1
  // failed" is the answer, and a caller that has to add it up itself is a
  // caller that can render five rows and a green tick.
  const summary = {
    total: results.length,
    refreshed: results.filter((r) => r.refreshed).length,
    pushed: results.filter((r) => r.outcome === "pushed").length,
    notPushed: results.filter((r) => r.outcome === "not-pushed").length,
    pushFailed: results.filter((r) => r.outcome === "push-failed").length,
    noCover: results.filter((r) => r.outcome === "no-cover").length,
    failed: results.filter((r) => r.outcome === "error" || r.outcome === "not-found").length,
    // The one flag worth naming: nothing at all went wrong, so the client may
    // say so in a single line. Anything else and it must show the rows.
    allSucceeded: results.every((r) => r.outcome === "pushed" || r.outcome === "not-pushed"),
  };

  await db.log
    .create({
      data: {
        level: summary.pushFailed + summary.failed > 0 ? "WARN" : "INFO",
        message:
          `general information: cover regenerate for ${results.length} style(s) ` +
          `from prod spec ${prodSpec.name} by user ${userId} — ` +
          `notify=${notifySupplier ? "yes" : "no"} — ` +
          results.map((r) => `${r.styleName ?? r.styleId}=${r.outcome}`).join(" "),
      },
    })
    .catch(() => {});

  return NextResponse.json({ results, summary });
}

function blank(styleId: string): StyleRunResult {
  return {
    styleId,
    styleName: null,
    prodSpecName: null,
    inThisSpec: false,
    refreshed: false,
    outcome: "error",
    reason: null,
    message: null,
    requeue: null,
    pushed: 0,
    pushFailed: 0,
    pushError: null,
    sharePointStatus: null,
    folderUrl: null,
    sharePointError: null,
  };
}

// One style: rebuild its cover, arm its supplier queue row, push it now.
async function runOne(
  style: RunStyle,
  notifySupplier: boolean,
  prodSpec: { id: string; name: string },
): Promise<StyleRunResult> {
  const base = {
    ...blank(style.id),
    styleName: style.name,
    prodSpecName: style.prodSpec?.name?.trim() ?? null,
    inThisSpec: style.prodSpecId === prodSpec.id,
  };

  // Lazy, exactly as the cover-sample route does it: the render chain pulls in
  // puppeteer, and none of the validation above needs it. A refused request
  // stays a cheap 404 instead of a cold start behind the whole PDF stack.
  const { refreshStyleCoverAsset } = await import("@/lib/pdf/refresh-cover");
  const { enqueueCoverForSupplier } = await import("@/lib/publish/requeue-cover");

  // The style id and nothing else — this is where "each style against its own
  // spec" is actually enforced. refreshStyleCoverAsset resolves the style's
  // current cover job and buildStyleCoverPdf reads that job's style's
  // prodSpec.generalInfoMd, so the open spec is structurally incapable of
  // leaking into a foreign style's cover.
  //
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
    return {
      ...base,
      outcome: refresh.status === "no-cover" ? "no-cover" : "error",
      reason: refresh.status,
      message:
        refresh.status === "no-cover"
          ? `${style.name} has never generated a bundle, so there is no cover to rebuild. ` +
            `It will include the current General information the first time it generates.`
          : refresh.status === "error"
            ? `Could not rebuild ${style.name}'s cover: ${refresh.error}`
            : `Nothing to do for ${style.name}.`,
    };
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
    console.warn(`[gi-regen] requeue failed for ${style.id}:`, err);
  }

  // Push now rather than waiting for the recurring sweep — the person is
  // standing here asking for the supplier's copy to be corrected. Scoped to
  // this one style id, so nothing else in the queue rides along, and so a
  // failure belongs to a named style rather than to the batch: one sweep of
  // five would hand back one `uploaded` count and one folder, which is exactly
  // the "four fine, one silently missing" reading this control exists to
  // prevent. It costs one /automation row per style, which is the honest
  // record — each really is its own delivery. Same path publish uses, so the
  // supplier-send master switch and the PO cutoff still apply (it returns 0
  // uploaded when batch-send is off, and the armed row waits for the switch).
  let pushed = 0;
  let pushFailed = 0;
  let pushError: string | null = null;
  if (requeue === "queued") {
    try {
      const { pushQueuedSupplierUploads } = await import("@/lib/sharepoint/push-queued-to-supplier");
      const sweep = await pushQueuedSupplierUploads({
        styleIds: [style.id],
        recordRunAs: "gi-regen",
      });
      pushed = sweep.uploaded;
      pushFailed = sweep.failed;
      pushError = sweep.failures[0]?.message ?? null;
    } catch (err) {
      pushFailed = 1;
      pushError = (err as Error).message;
      console.warn(`[gi-regen] SharePoint push failed for ${style.id}:`, err);
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

  return {
    ...base,
    refreshed: true,
    outcome: pushFailed > 0 ? "push-failed" : pushed > 0 ? "pushed" : "not-pushed",
    reason: refresh.status,
    message: null,
    requeue,
    pushed,
    pushFailed,
    pushError,
    sharePointStatus: queueRow?.sharePointStatus ?? null,
    folderUrl: queueRow?.sharePointFolderUrl ?? style.supplierFolderUrl ?? null,
    sharePointError: queueRow?.sharePointError ?? null,
  };
}

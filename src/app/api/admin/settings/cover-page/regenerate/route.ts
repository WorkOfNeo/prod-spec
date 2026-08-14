import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  listCoverRefreshableStyleIds,
  countDeliveredAmong,
  processCoverRefreshChunk,
} from "@/lib/pdf/cover-regen-sweep";
import {
  stampCoverBannerDismissed,
  stampCoverRegenerated,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";
// Each chunk renders a handful of cover PDFs (Chromium) — give it headroom.
export const maxDuration = 300;

// "Regenerate cover pages" sweep — rebuilds the CURRENT cover of every style
// that already has one so a new cover format / edited global cover block
// reaches existing (incl. approved) styles without a full re-run.
// Client-driven + chunked: the browser calls `prepare` for the id list, then
// POSTs bounded `process` chunks and shows progress. Idempotent throughout.
//
//   POST { mode: "prepare", prodSpecId? }
//     → { styleIds: string[], total, delivered }
//   POST { mode: "process", styleIds: string[], deliver?: boolean,
//          onlyPending?: boolean, final?: boolean }
//   POST { mode: "dismiss" }  → { ok } — clears the stale-content banner
//     → { outcomes, pushed, pushErrors, refreshed, noCover, skippedApproved,
//         errors, requeued }
//
// ADMIN + REVIEWER, because reviewers now author both texts the cover carries
// (the global block and each spec's General information) and an edit nobody can
// publish is only half a handover. It is NOT a quiet action: it overwrites
// delivered covers and re-arms the supplier push + nightly digest, so `prepare`
// returns the delivered count and the UI puts it behind an explicit confirm.
// `prodSpecId` scopes the sweep to one Customer × Business Area — the blast
// radius of a General-information edit.

const PREPARE = z.object({
  mode: z.literal("prepare"),
  prodSpecId: z.string().min(1).optional(),
});
const PROCESS = z.object({
  mode: z.literal("process"),
  // Bounded per request so one chunk always finishes inside maxDuration.
  styleIds: z.array(z.string().min(1)).min(1).max(25),
  deliver: z.boolean().default(true),
  // Skip styles whose outputs are all approved — their manifest prints no
  // status wording, so rebuilding is a visual no-op that still overwrites the
  // supplier's copy for a finished order. Defaults ON: the sweep exists to
  // propagate cover CHANGES, and an all-approved cover has none to show.
  onlyPending: z.boolean().default(true),
  // Set by the client on the LAST chunk of a run it drove to completion. Only
  // then is the "covers are up to date" stamp written — a sweep the operator
  // stopped halfway must not clear the stale banner, or the banner would lie
  // about the styles that never got processed.
  final: z.boolean().default(false),
});
// Waves the stale banner away without running anything. Estate-wide, like the
// prose it tracks: one shared block, not a personal to-do.
const DISMISS = z.object({ mode: z.literal("dismiss") });
const BODY = z.discriminatedUnion("mode", [PREPARE, PROCESS, DISMISS]);

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  if (parsed.data.mode === "dismiss") {
    await stampCoverBannerDismissed().catch(() => {});
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.mode === "prepare") {
    const styleIds = await listCoverRefreshableStyleIds({ prodSpecId: parsed.data.prodSpecId });
    const delivered = await countDeliveredAmong(styleIds);
    return NextResponse.json({ styleIds, total: styleIds.length, delivered });
  }

  const { styleIds, deliver, onlyPending, final } = parsed.data;
  const { outcomes, pushed, pushErrors } = await processCoverRefreshChunk(styleIds, {
    deliver,
    onlyPending,
  });

  const refreshed = outcomes.filter((o) => o.status === "refreshed").length;
  const noCover = outcomes.filter((o) => o.status === "no-cover").length;
  const skippedApproved = outcomes.filter((o) => o.status === "skipped-all-approved").length;
  const errored = outcomes.filter((o) => o.status === "error");
  const requeued = outcomes.filter((o) => o.requeue === "queued").length;

  if (errored.length > 0) {
    await db.log
      .create({
        data: {
          level: "WARN",
          message:
            `cover-regen chunk: ${errored.length} cover(s) failed to refresh — ` +
            errored
              .map((o) => `${o.styleId}: ${o.status === "error" ? o.error : ""}`)
              .join(" · ")
              .slice(0, 800),
        },
      })
      .catch(() => {});
  }

  // Fail-soft, and deliberately AFTER the work: the stamp claims the estate's
  // covers match the current prose, so it must never run ahead of the renders.
  if (final) await stampCoverRegenerated().catch(() => {});

  return NextResponse.json({
    outcomes,
    refreshed,
    noCover,
    skippedApproved,
    errors: errored.length,
    requeued,
    pushed,
    pushErrors,
  });
}

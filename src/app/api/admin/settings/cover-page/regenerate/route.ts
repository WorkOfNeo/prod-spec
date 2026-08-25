import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  listCoverRefreshableStyleIds,
  countDeliveredAmong,
  processCoverRefreshChunk,
} from "@/lib/pdf/cover-regen-sweep";

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
//          onlyPending?: boolean }
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
  // Skip covers whose printed manifest already matches what they'd render.
  // Defaults ON: without it a repeat sweep re-uploads every cover in the book
  // to change nothing. This is also what makes the sweep resumable — a stopped
  // run picks up where it left off instead of redoing the finished chunks.
  onlyChanged: z.boolean().default(true),
  // Default FALSE — the opposite of `deliver`. A sweep is a bulk, operator-
  // initiated act across orders whose suppliers have nothing new to do; the
  // file belongs in their folder, an email about it does not. Callers must ask
  // for the email explicitly.
  notifySupplier: z.boolean().default(false),
});
const BODY = z.discriminatedUnion("mode", [PREPARE, PROCESS]);

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

  if (parsed.data.mode === "prepare") {
    const styleIds = await listCoverRefreshableStyleIds({ prodSpecId: parsed.data.prodSpecId });
    const delivered = await countDeliveredAmong(styleIds);
    return NextResponse.json({ styleIds, total: styleIds.length, delivered });
  }

  const { styleIds, deliver, onlyPending, onlyChanged, notifySupplier } = parsed.data;
  const { outcomes, pushed, pushErrors } = await processCoverRefreshChunk(styleIds, {
    deliver,
    onlyPending,
    onlyChanged,
    notifySupplier,
  });

  const refreshed = outcomes.filter((o) => o.status === "refreshed").length;
  const noCover = outcomes.filter((o) => o.status === "no-cover").length;
  const skippedApproved = outcomes.filter((o) => o.status === "skipped-all-approved").length;
  const skippedUnchanged = outcomes.filter((o) => o.status === "skipped-unchanged").length;
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

  return NextResponse.json({
    outcomes,
    refreshed,
    noCover,
    skippedApproved,
    skippedUnchanged,
    errors: errored.length,
    requeued,
    pushed,
    pushErrors,
  });
}

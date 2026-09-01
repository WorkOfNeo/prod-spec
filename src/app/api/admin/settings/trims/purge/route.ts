import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { clearTrimLabelOverrides, getTrimLabelOverrides } from "@/lib/settings/app-settings";
import { buildOverridePurgePreview } from "@/lib/trims/census";

export const runtime = "nodejs";
// Same single pluck as the census — seconds against a remote database, past the
// default budget.
export const maxDuration = 120;

// Wash the stored per-label trim decisions.
//
// WHY THIS EXISTS. The vocabulary screen used to survey EVERY style in the
// book, so labels from long-dead pre-cutoff orders reached the queue, a person
// mapped them, and those decisions then shaped what a live cover prints. The
// census is now scoped to the generation cutoff, but the decisions already
// stored were made against the old, unscoped set — so there has to be a way to
// drop them and re-map only what survives.
//
// PREVIEWABLE AND USER-TRIGGERED, ALWAYS. Nothing here runs on page load and
// nothing runs as a migration side effect: GET shows exactly what would go,
// with per-label counts of how many in-scope styles still use it, and POST
// requires an explicit { confirm: true }. Losing a mapping is cheap to redo but
// invisible when it happens silently, which is the failure mode this shape
// exists to prevent.
//
//   GET  /api/admin/settings/trims/purge                 -> preview
//   POST /api/admin/settings/trims/purge { confirm:true } -> drops them
//
// Rules and layout pins are NOT touched — see clearTrimLabelOverrides.

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const overrides = await getTrimLabelOverrides();
  const preview = await buildOverridePurgePreview(overrides);
  return NextResponse.json(preview);
}

// ADMIN only. Reviewers decide what a trim MEANS (and can clear any single
// decision from the editor next door); wiping the whole set is configuration,
// and matches the ADMIN gate on the PO cutoffs this now scopes to.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== true) {
    return NextResponse.json(
      { error: "Body must be { confirm: true } — the purge is never implicit" },
      { status: 400 },
    );
  }

  const removed = await clearTrimLabelOverrides();
  await db.log.create({
    data: {
      level: "INFO",
      message: `trim label overrides purged by user ${auth.userId} — ${removed} stored decision(s) dropped; the vocabulary re-gathers scoped to the generation PO cutoff`,
    },
  });

  return NextResponse.json({ ok: true, removed });
}

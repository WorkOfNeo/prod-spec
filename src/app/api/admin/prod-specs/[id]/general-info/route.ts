import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// The "General information" markdown of ONE Prod Spec (= one Customer ×
// Business Area — the pair is unique on the row), as its own single-column
// endpoint. ADMIN + REVIEWER.
//
//   GET   /api/admin/prod-specs/<id>/general-info          → { markdown, name }
//   PATCH /api/admin/prod-specs/<id>/general-info { markdown }
//
// WHY THIS EXISTS instead of widening the main PATCH's role. The main
// /api/admin/prod-specs/<id> PATCH is the whole editor's autosave: one payload
// carrying name, active, fullyApproved, threshold, outputs, logo, page
// settings, care instructions and languages. Two things make it the wrong door
// for a reviewer:
//
//   1. It's a config surface. Widening its role hands out the output set and
//      the approval toggles along with the prose.
//   2. It AUTO-ACTIVATES. `hasOtherChange` there counts generalInfoMd, so
//      saving prose flips a draft spec's `active` to true — which is what makes
//      a spec eligible for Job auto-enqueue. A reviewer fixing a typo on a
//      half-configured spec would arm it.
//
// This route writes generalInfoMd and nothing else, and deliberately never
// touches `active`: prose is not approval. Admins keep using the full editor,
// where auto-activation on save is the intended behaviour.
//
// NOTE (pre-existing, unchanged): the full editor autosaves generalInfoMd as
// part of its payload, so an admin with that editor open can overwrite a
// concurrent edit made here on their next autosave. Last write wins, as before.

// Matches the main PATCH's ceiling for the same column — many pages of
// markdown, while still stopping an accidental paste bomb.
const BODY_SCHEMA = z.object({ markdown: z.string().max(100_000) });

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const prodSpec = await db.prodSpec.findUnique({
    where: { id },
    select: { id: true, name: true, generalInfoMd: true },
  });
  if (!prodSpec) return NextResponse.json({ error: "Prod spec not found" }, { status: 404 });

  return NextResponse.json({ markdown: prodSpec.generalInfoMd ?? "", name: prodSpec.name });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Body must be { markdown: string }" },
      { status: 400 },
    );
  }

  const existing = await db.prodSpec.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Prod spec not found" }, { status: 404 });

  // Blank ⇒ null, matching the main PATCH: an empty column is what suppresses
  // the General information pages inside the cover PDF.
  const markdown = parsed.data.markdown;
  const updated = await db.prodSpec.update({
    where: { id },
    data: { generalInfoMd: markdown.trim() ? markdown : null },
    select: { generalInfoMd: true, name: true },
  });

  await db.log
    .create({
      data: {
        level: "INFO",
        message:
          `general information ${updated.generalInfoMd ? "updated" : "cleared"} for prod spec ` +
          `${updated.name} (${id}) by user ${auth.userId}`,
      },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, markdown: updated.generalInfoMd ?? "" });
}

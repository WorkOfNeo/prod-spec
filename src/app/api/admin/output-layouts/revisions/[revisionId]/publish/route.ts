import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { publishRevision } from "@/lib/output-layouts/revisions";
import {
  gateRevisionRoute,
  readJsonObject,
  revisionErrorResponse,
  toRevisionSummary,
} from "@/lib/output-layouts/revision-http";

export const runtime = "nodejs";

// Put a draft live (publishRevision, design §5.1): the one admin-initiated
// path that writes OutputLayout.definition from a revision. Body { force? }.
//
// 409 { error, conflict } when the live layout moved since the draft was made
// (a builder edit or another publish) — `force: true` overwrites that, and
// the response's `overrodeConflict` says what was overwritten. 409 { error }
// for a revision that isn't a draft, 422 { error, details } when the
// definition fails the publish gate. ADMIN only; 404 while
// CHANGE_REQUESTS_ENABLED is off.

const PUBLISH_SCHEMA = z.object({ force: z.boolean().optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  const gate = await gateRevisionRoute();
  if (!gate.ok) return gate.response;

  const { revisionId } = await ctx.params;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = PUBLISH_SCHEMA.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await publishRevision(revisionId, { userId: gate.userId, force: parsed.data.force === true });
    return NextResponse.json({ ...result, revision: toRevisionSummary(result.revision) });
  } catch (err) {
    return revisionErrorResponse(err);
  }
}

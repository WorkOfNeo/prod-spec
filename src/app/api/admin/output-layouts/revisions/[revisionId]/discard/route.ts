import { NextResponse, type NextRequest } from "next/server";
import { discardDraft } from "@/lib/output-layouts/revisions";
import { gateRevisionRoute, revisionErrorResponse } from "@/lib/output-layouts/revision-http";

export const runtime = "nodejs";

// Throw a draft away (DRAFT → DISCARDED). Only a draft: a published,
// superseded or already discarded revision answers 409, so a draft published a
// moment ago is never flipped behind the publisher's back. Nothing that prints
// changes. ADMIN only; 404 while CHANGE_REQUESTS_ENABLED is off.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  const gate = await gateRevisionRoute();
  if (!gate.ok) return gate.response;

  const { revisionId } = await ctx.params;
  try {
    await discardDraft(revisionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return revisionErrorResponse(err);
  }
}

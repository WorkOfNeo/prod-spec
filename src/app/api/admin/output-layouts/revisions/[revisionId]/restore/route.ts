import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { restoreRevision } from "@/lib/output-layouts/revisions";
import {
  gateRevisionRoute,
  readJsonObject,
  revisionErrorResponse,
  toRevisionSummary,
} from "@/lib/output-layouts/revision-http";

export const runtime = "nodejs";

// Put an earlier state back live (restoreRevision, design §5.1). Body
// { which: "definition" | "base" }: "definition" = this revision as it was
// published (published revisions only), "base" = what was live before it was
// made. Either way a NEW revision is drafted and published, so history only
// moves forward and the layout version bumps.
//
// 409 { error } for restoring a never-published draft's definition, 409
// { error, conflict } if the layout moved in the same instant, 422
// { error, details } when the old definition no longer passes today's publish
// gate. ADMIN only; 404 while CHANGE_REQUESTS_ENABLED is off.

const RESTORE_SCHEMA = z.object({ which: z.enum(["definition", "base"]) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  const gate = await gateRevisionRoute();
  if (!gate.ok) return gate.response;

  const { revisionId } = await ctx.params;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = RESTORE_SCHEMA.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Body must be { which: "definition" | "base" }', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await restoreRevision(revisionId, { userId: gate.userId, which: parsed.data.which });
    return NextResponse.json({ ...result, revision: toRevisionSummary(result.revision) });
  } catch (err) {
    return revisionErrorResponse(err);
  }
}

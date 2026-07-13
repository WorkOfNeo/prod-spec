import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { buildAiFixProposal, AiFixError, fixKindForVariantKey } from "@/lib/rejection-ai/ai-fix";
import { buildGeneralInfoAiFixProposal } from "@/lib/rejection-ai/general-info-fix";
import { AiNotConfiguredError, AiResponseError } from "@/lib/rejection-ai/anthropic";

export const runtime = "nodejs";
// Style load + one Claude call — seconds, but give it headroom.
export const maxDuration = 60;

// Ask the AI for a proposed fix to a rejected output. Reads only — nothing is
// saved. Dispatches by the ticket's output kind: an Output Builder layout
// (line-text edits) or the General information page (markdown rewrite). Returns
// a `kind`-tagged proposal the dialog renders. ADMIN only.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  try {
    const ticket = await db.rejectionTicket.findUnique({ where: { id }, select: { variantKey: true } });
    if (!ticket) return NextResponse.json({ error: "This rejection ticket no longer exists." }, { status: 404 });

    const kind = fixKindForVariantKey(ticket.variantKey);
    if (kind === "layout") {
      return NextResponse.json({ proposal: await buildAiFixProposal(id) });
    }
    if (kind === "general-info") {
      return NextResponse.json({ proposal: await buildGeneralInfoAiFixProposal(id) });
    }
    return NextResponse.json(
      { error: "This output isn't AI-editable — only Output Builder layouts and the General information page are." },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof AiFixError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    if (err instanceof AiNotConfiguredError) return NextResponse.json({ error: err.message }, { status: 503 });
    if (err instanceof AiResponseError) return NextResponse.json({ error: err.message }, { status: 502 });
    console.error("[ai-fix] proposal failed", err);
    return NextResponse.json({ error: "AI fix failed — try again." }, { status: 500 });
  }
}

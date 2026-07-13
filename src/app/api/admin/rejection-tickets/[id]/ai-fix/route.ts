import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { buildAiFixProposal, AiFixError } from "@/lib/rejection-ai/ai-fix";
import { AiNotConfiguredError, AiResponseError } from "@/lib/rejection-ai/anthropic";

export const runtime = "nodejs";
// Style load + one Claude call — seconds, but give it headroom.
export const maxDuration = 60;

// Ask the AI for a proposed fix to a rejected Output Builder layout. Reads
// only — nothing is saved. Returns the current + proposed definitions (so the
// dialog can render before/after previews), the applied line edits, the
// blast-radius count, and the model's note. ADMIN only.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  try {
    const proposal = await buildAiFixProposal(id);
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof AiFixError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    if (err instanceof AiNotConfiguredError) return NextResponse.json({ error: err.message }, { status: 503 });
    if (err instanceof AiResponseError) return NextResponse.json({ error: err.message }, { status: 502 });
    console.error("[ai-fix] proposal failed", err);
    return NextResponse.json({ error: "AI fix failed — try again." }, { status: 500 });
  }
}

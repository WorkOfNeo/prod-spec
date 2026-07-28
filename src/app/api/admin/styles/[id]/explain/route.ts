import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { buildStyleExplainBundle, explainPointers } from "@/lib/styles/explain";
import { answerStyleQuestion, StyleExplainError } from "@/lib/styles/explain-ai";
import { AiNotConfiguredError, AiResponseError } from "@/lib/rejection-ai/anthropic";

// =====================================================
// "What's up with this style?" — the free-text Q&A endpoint.
//
// GET  → the deterministic evidence bundle on its own. No model involved, so
//        this is what the always-on panel reads and what a reviewer sees even
//        when ANTHROPIC_API_KEY isn't set.
// POST → the same bundle, narrated in answer to a specific question.
//
// The split matters: the diagnosis is always available, and the AI is only a
// reading of it. If the model is unreachable the page degrades to facts rather
// than to nothing.
// =====================================================

export const runtime = "nodejs";
// The folder leg makes several Microsoft Graph round-trips (resolve supplier
// root → list PO folders → list APPROVED LAYOUTS), and the AI call follows it.
// Comfortably longer than the default so a slow drive doesn't 504 the answer.
export const maxDuration = 120;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const bundle = await buildStyleExplainBundle(id, {
    includeFolder: true,
    role: role === "ADMIN" ? "ADMIN" : "REVIEWER",
  });
  if (!bundle) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  return NextResponse.json({ bundle, pointers: explainPointers(bundle) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  let question = "";
  try {
    const body = (await req.json()) as { question?: unknown };
    if (typeof body?.question === "string") question = body.question;
  } catch {
    // Fall through to the empty-question error below, which reads better than
    // a generic "invalid JSON".
  }

  const { id } = await ctx.params;
  const bundle = await buildStyleExplainBundle(id, {
    includeFolder: true,
    role: role === "ADMIN" ? "ADMIN" : "REVIEWER",
  });
  if (!bundle) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  try {
    const answer = await answerStyleQuestion({
      question,
      bundle,
      pointers: explainPointers(bundle),
    });
    // The bundle rides along with the answer so the panel can show the facts
    // the answer was drawn from — the reviewer can always check the working.
    return NextResponse.json({ answer, bundle });
  } catch (err) {
    if (err instanceof StyleExplainError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof AiNotConfiguredError) {
      // Not a failure the reviewer can act on, and the facts are still good —
      // 503 + the bundle, so the panel drops to "here's what I can see".
      return NextResponse.json({ error: err.message, bundle }, { status: 503 });
    }
    if (err instanceof AiResponseError) {
      return NextResponse.json({ error: err.message, bundle }, { status: 502 });
    }
    throw err;
  }
}

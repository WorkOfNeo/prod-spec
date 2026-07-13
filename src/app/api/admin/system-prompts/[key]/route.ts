import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import {
  upsertSystemPrompt,
  resetSystemPrompt,
  isKnownPromptKey,
  defaultSystemPrompt,
} from "@/lib/prompts/system-prompts";

export const runtime = "nodejs";

// Save (PUT) or reset-to-default (DELETE) one editable AI system prompt.
// ADMIN only. Keys are validated against the code registry so an unknown key
// can't create a stray row.
const BODY = z.object({ content: z.string().min(1).max(20000) });

export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { key } = await ctx.params;
  if (!isKnownPromptKey(key)) return NextResponse.json({ error: "Unknown prompt" }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Prompt must be 1–20000 characters." }, { status: 400 });
  }

  try {
    await upsertSystemPrompt(key, parsed.data.content, session.user.email);
  } catch (err) {
    // Most likely the table isn't deployed yet (db:deploy pending).
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { key } = await ctx.params;
  if (!isKnownPromptKey(key)) return NextResponse.json({ error: "Unknown prompt" }, { status: 404 });

  await resetSystemPrompt(key);
  return NextResponse.json({ ok: true, content: defaultSystemPrompt(key) });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { MemoryUpdateError, updateMemory, type MemoryUpdateErrorCode } from "@/lib/change-requests/memory";
import { MemoryStateSchema } from "@/lib/change-requests/types";

export const runtime = "nodejs";

// Keep / dismiss / forget / restore one agent note, or reword it (design
// §5.9). ADMIN only — a kept note is read by every later agent run. Behind
// CHANGE_REQUESTS_ENABLED (404 before any auth check when off).
//
// PATCH { state?: PROPOSED|KEPT|DISMISSED|FORGOTTEN, text?: string }
// Which moves are legal, and when text may change, is decided in memory.ts
// (planMemoryUpdate); this route only shapes the body and maps the outcome.
const BODY = z
  .object({
    state: MemoryStateSchema.optional(),
    // Generous here; memory.ts enforces the real limit with a readable message.
    text: z.string().max(10_000).optional(),
  })
  .strict();

const STATUS: Record<MemoryUpdateErrorCode, number> = {
  not_found: 404,
  empty: 400,
  invalid_text: 400,
  invalid_transition: 409,
  not_editable: 409,
  conflict: 409,
};

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send { state?, text? } with a known state and text as a string." },
      { status: 400 },
    );
  }

  try {
    const memory = await updateMemory(id, parsed.data);
    return NextResponse.json({ memory });
  } catch (err) {
    if (err instanceof MemoryUpdateError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS[err.code] });
    }
    throw err;
  }
}

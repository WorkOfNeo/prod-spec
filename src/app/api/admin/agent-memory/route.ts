import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { createManualMemory, listMemories, NewMemoryError } from "@/lib/change-requests/memory";
import { MemoryScopeSchema, MemoryStateSchema } from "@/lib/change-requests/types";

export const runtime = "nodejs";

// The agent's notes (design §5.9), for /settings/agent-memory. ADMIN only:
// these steer every future agent run. Behind CHANGE_REQUESTS_ENABLED — with
// the flag off the route doesn't exist (404 before any auth check).
//
// GET  ?scope=GLOBAL|CUSTOMER|DOC_TYPE|MONDAY&state=PROPOSED|KEPT|DISMISSED|FORGOTTEN
// POST { scope, scopeRef?, text } — a note written by hand, kept at once
//      (scopeRef: the customer id or doc-type value; memory.ts checks it).
export async function GET(req: NextRequest) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const params = req.nextUrl.searchParams;
  const rawScope = params.get("scope") || undefined;
  const rawState = params.get("state") || undefined;
  const scope = rawScope === undefined ? undefined : MemoryScopeSchema.safeParse(rawScope);
  const state = rawState === undefined ? undefined : MemoryStateSchema.safeParse(rawState);
  if (scope && !scope.success) return NextResponse.json({ error: `Unknown scope: ${rawScope}` }, { status: 400 });
  if (state && !state.success) return NextResponse.json({ error: `Unknown state: ${rawState}` }, { status: 400 });

  const memories = await listMemories({ scope: scope?.data, state: state?.data });
  return NextResponse.json({ memories });
}

const NEW_NOTE = z
  .object({
    scope: z.string(),
    scopeRef: z.string().max(200).nullish(),
    // Generous here; memory.ts enforces the real limit with a readable message.
    text: z.string().max(10_000),
  })
  .strict();

export async function POST(req: NextRequest) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const parsed = NEW_NOTE.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send { scope, scopeRef?, text }." }, { status: 400 });
  }
  try {
    const memory = await createManualMemory({ ...parsed.data, userId: session.user.id });
    return NextResponse.json({ memory }, { status: 201 });
  } catch (err) {
    if (err instanceof NewMemoryError) return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    throw err;
  }
}

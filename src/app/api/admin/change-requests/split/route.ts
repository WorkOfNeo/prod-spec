import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { MAX_MESSAGE_CHARS, MAX_OUTPUTS } from "@/lib/change-requests/requests";
import { SplitError, splitRequestByOutput } from "@/lib/change-requests/agent/split";

export const runtime = "nodejs";
// One small model call; give it room on a slow day.
export const maxDuration = 60;

// "Split by output" on /requests/new: POST { text, outputs: [{ variantKey,
// label }] } → { issues: [{ variantKey | null, label, text }], note? }.
// Writes nothing — the form fills its textareas and the requester edits them
// before sending. Same gate as filing a request: flag (404), session (401),
// canReview (403). Without an API key the text is copied to every output.
const SCHEMA = z.object({
  text: z.string().trim().min(1, "Paste the text to split").max(MAX_MESSAGE_CHARS),
  outputs: z
    .array(z.object({ variantKey: z.string().min(1).max(200), label: z.string().trim().min(1).max(200) }))
    .min(1, "Pick at least one output first")
    .max(MAX_OUTPUTS),
});

export async function POST(req: NextRequest) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  try {
    return NextResponse.json(await splitRequestByOutput(parsed.data));
  } catch (err) {
    if (err instanceof SplitError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}

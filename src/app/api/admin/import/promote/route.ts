// POST /api/admin/import/promote
//
// Bulk promote selected ghost items into Style rows. Each entry pairs a
// ghost item with the customer the operator chose (for unambiguous rows
// the UI sends the auto-resolved customer; for the disambiguation bucket
// the UI sends the per-row picked customer). The promote function
// re-validates that the chosen customer is actually a trie candidate or
// matches the ghost item's customerLink column.
//
// Per-item failures don't abort the batch — they're collected into
// `failures` so the UI can show "imported 198 / 200; 2 errors".
//
// Triggers the job runner ONCE at the end if any jobs were enqueued.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { promoteGhostToStyle, PromoteError } from "@/lib/import/promote";
import { triggerRunner } from "@/lib/queue/trigger";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  items: z
    .array(
      z.object({
        ghostItemId: z.string().min(1),
        customerId: z.string().min(1),
      }),
    )
    .min(1)
    .max(200),
});

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let promoted = 0;
  let alreadyExisted = 0;
  let jobsEnqueued = 0;
  const failures: Array<{ ghostItemId: string; error: string; code?: string }> = [];

  for (const item of parsed.data.items) {
    try {
      const r = await promoteGhostToStyle(item);
      promoted++;
      if (r.alreadyExisted) alreadyExisted++;
      if (r.jobEnqueued) jobsEnqueued++;
    } catch (err) {
      if (err instanceof PromoteError) {
        failures.push({ ghostItemId: item.ghostItemId, error: err.message, code: err.code });
      } else {
        failures.push({ ghostItemId: item.ghostItemId, error: (err as Error).message });
      }
    }
  }

  if (jobsEnqueued > 0) {
    await triggerRunner();
  }

  return NextResponse.json({ promoted, alreadyExisted, jobsEnqueued, failures });
}

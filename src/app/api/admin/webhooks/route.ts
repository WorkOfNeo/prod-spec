import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { createWebhook, listWebhooks, type WebhookEvent } from "@/lib/monday/client";

export const runtime = "nodejs";

const EVENT_SCHEMA = z.enum([
  "create_item",
  "create_subitem",
  "change_column_value",
  "change_status_column_value",
  "change_specific_column_value",
  "item_archived",
  "item_deleted",
  "item_moved_to_any_group",
] satisfies readonly WebhookEvent[]);

const BODY_SCHEMA = z.object({
  boardId: z.string().min(1),
  events: z.array(EVENT_SCHEMA).min(1),
});

function buildWebhookUrl(): string {
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "");
  const token = process.env.MONDAY_WEBHOOK_SECRET;
  if (!base) throw new Error("PROD_SPEC_BASE_URL not set");
  if (!token) throw new Error("MONDAY_WEBHOOK_SECRET not set");
  return `${base}/api/webhooks/monday?token=${encodeURIComponent(token)}`;
}

export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const webhooks = await db.mondayWebhook.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ webhooks });
}

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
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { boardId, events } = parsed.data;
  const url = buildWebhookUrl();

  // Cross-reference our local registry. We register only what's missing —
  // never delete-then-recreate. See CLAUDE.md global rule on webhooks.
  const existing = await db.mondayWebhook.findMany({ where: { boardId } });
  const existingEvents = new Set(existing.map((w) => w.eventType));

  const created: Array<{ event: WebhookEvent; mondayWebhookId: string }> = [];
  const skipped: WebhookEvent[] = [];

  for (const event of events) {
    if (existingEvents.has(event)) {
      skipped.push(event);
      continue;
    }
    const result = await createWebhook({ boardId, url, event });
    await db.mondayWebhook.create({
      data: {
        mondayWebhookId: String(result.id),
        boardId: String(boardId),
        eventType: event,
        url,
      },
    });
    created.push({ event, mondayWebhookId: String(result.id) });
  }

  // Reconcile: pull from Monday to surface any subscriptions that exist
  // remotely but not in our DB (e.g. created via the Monday UI). We do NOT
  // touch them — just report them so an admin can decide manually.
  const remote = await listWebhooks(boardId);
  const localIds = new Set([...existing.map((w) => w.mondayWebhookId), ...created.map((c) => c.mondayWebhookId)]);
  const foreign = remote.filter((r) => !localIds.has(String(r.id)));

  return NextResponse.json({
    boardId,
    created,
    skipped,
    foreign,
  });
}

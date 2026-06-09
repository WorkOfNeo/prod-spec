import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isChallenge, isEventPayload, verifyWebhookRequest } from "@/lib/monday/webhook";
import { ingestMondayItem, markStyleArchived, markStyleDeleted } from "@/lib/monday/ingest";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { hasAllRequiredDetailFields } from "@/lib/styles/detail-fields";
import { triggerRunner, triggerEanRunner } from "@/lib/queue/trigger";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { getItem } from "@/lib/monday/client";
import { upsertCustomerFromMondayItem, upsertSupplierFromMondayItem } from "@/lib/monday/sync";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Initial endpoint verification — Monday POSTs { challenge } once on create_webhook.
  if (isChallenge(body)) {
    return NextResponse.json({ challenge: body.challenge });
  }

  const verified = verifyWebhookRequest(req);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  if (!isEventPayload(body)) {
    return NextResponse.json({ error: "Unrecognized payload" }, { status: 400 });
  }

  const { event } = body;
  const boardId = event.boardId ? String(event.boardId) : null;

  await db.log.create({
    data: {
      level: "INFO",
      message: `monday.webhook ${event.type} board=${boardId ?? "?"} pulse=${event.pulseId ?? "?"}`,
      payload: body as unknown as object,
    },
  });

  if (!event.pulseId) {
    // Some events (e.g. column-settings changes) don't carry a pulseId.
    return NextResponse.json({ ok: true, skipped: "no pulseId" });
  }

  // Soft lifecycle: an archived / deleted Monday item is flagged on the mirror
  // (never dropped) so its row + Log trail survive for audit and the styles
  // list stops surfacing it. Don't fall through to ingest — the item may no
  // longer be fetchable from Monday.
  if (event.type === "item_archived" || event.type === "item_deleted") {
    const lifecycle =
      event.type === "item_deleted"
        ? await markStyleDeleted(event.pulseId)
        : await markStyleArchived(event.pulseId);
    await db.log.create({
      data: {
        level: "INFO",
        message: lifecycle.matched
          ? `style ${lifecycle.styleId} flagged ${event.type} (hidden from UI, retained for log)`
          : `${event.type} for unknown item ${event.pulseId} — nothing in mirror to flag`,
        payload: { pulseId: event.pulseId, type: event.type, styleId: lifecycle.styleId },
      },
    });
    return NextResponse.json({ ok: true });
  }

  try {
    if (boardId === MONDAY_BOARDS.preOrder) {
      // Pre-Order is the single source of truth for Style rows.
      await handleStyleEvent(event.pulseId);
    } else if (boardId === MONDAY_BOARDS.styles) {
      // Styles board is no longer a source — ignore its events so we don't
      // re-create legacy Styles-board rows alongside the Pre-Order styles.
      await db.log.create({
        data: {
          level: "INFO",
          message: `monday.webhook styles-board event ignored (Pre-Order is source) pulse=${event.pulseId}`,
        },
      });
    } else if (boardId === MONDAY_BOARDS.customers) {
      await handleCustomerEvent(event.pulseId);
    } else if (boardId === MONDAY_BOARDS.suppliers) {
      await handleSupplierEvent(event.pulseId);
    } else {
      await db.log.create({
        data: {
          level: "WARN",
          message: `monday.webhook unknown board ${boardId} — event ignored`,
          payload: { pulseId: event.pulseId, boardId },
        },
      });
    }
  } catch (err) {
    await db.log.create({
      data: {
        level: "ERROR",
        message: `failed to handle event for item ${event.pulseId}: ${(err as Error).message}`,
        payload: { pulseId: event.pulseId, boardId, error: (err as Error).message },
      },
    });
  }

  return NextResponse.json({ ok: true });
}

async function handleStyleEvent(pulseId: number): Promise<void> {
  const result = await ingestMondayItem(pulseId);
  await db.log.create({
    data: {
      level: "INFO",
      message: `style ${result.styleId} synced (${result.completionPct}%)`,
      payload: { styleId: result.styleId, completionPct: result.completionPct, missingFields: result.missingFields },
    },
  });

  // A freshly-filled (or changed) PO number queued EAN resolution — kick the
  // runner. Independent of PDF auto-generation: EANs resolve regardless of the
  // auto-generate master switch or ProdSpec state.
  if (result.eanQueued) {
    await triggerEanRunner();
  }

  // Global master switch — when auto-generation is OFF, sync the style
  // but never enqueue. Short-circuits ahead of the per-ProdSpec checks.
  const autoGenerateEnabled = await getAutoGenerateEnabled();

  // Auto-enqueue only when the ProdSpec is ACTIVE — operator hasn't yet
  // reviewed inactive scaffolds. Threshold + required-detail-fields +
  // in-flight checks. The detail-field check is last so it only queries
  // for an otherwise-eligible style.
  if (
    autoGenerateEnabled &&
    result.prodSpecActive &&
    result.completionPct >= result.autoGenerateThresholdPct &&
    (await hasAllRequiredDetailFields(result.styleId))
  ) {
    const inflight = await db.job.count({
      where: { styleId: result.styleId, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (inflight === 0) {
      await enqueueGenerationJob({ styleId: result.styleId, triggerSource: "WEBHOOK" });
      await triggerRunner();
    }
  }
}

async function handleCustomerEvent(pulseId: number): Promise<void> {
  const item = await getItem(pulseId);
  if (!item) throw new Error(`customer item ${pulseId} not found`);
  await upsertCustomerFromMondayItem(item);
  await db.log.create({
    data: { level: "INFO", message: `customer mirror updated from monday ${pulseId}` },
  });
}

async function handleSupplierEvent(pulseId: number): Promise<void> {
  const item = await getItem(pulseId);
  if (!item) throw new Error(`supplier item ${pulseId} not found`);
  await upsertSupplierFromMondayItem(item);
  await db.log.create({
    data: { level: "INFO", message: `supplier mirror updated from monday ${pulseId}` },
  });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST only. Use Monday create_webhook." });
}

// Promote one MondayGhostItem into a first-class Style row.
//
// Mirrors src/lib/monday/ingest.ts but reads ONLY from the ghost mirror —
// no live Monday API call. This is what makes bulk Manual Import fast
// (~3-5s for 200 items) and resilient against Monday rate limits or
// outages: the data we sunk is the data we promote.
//
// The function is idempotent on `Style.mondayItemId`: re-promoting an
// already-imported ghost item runs the same upsert path the webhook
// ingest would, refreshing snapshot fields and conditionally re-enqueuing
// a Job if the threshold check now passes. Callers expect `alreadyExisted`
// to indicate whether a Style row was new.

import { db } from "@/lib/db";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { hasAllRequiredDetailFields } from "@/lib/styles/detail-fields";
import { evaluateCompletion } from "@/lib/monday/completion";
import { parseCustomerConfig } from "@/lib/customers/config";
import { parseProdSpecRequiredFields } from "@/lib/prod-spec/config";
import {
  backfillStyleProdSpecLinks,
  ensureProdSpecsForStyle,
} from "@/lib/prod-spec/ensure";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { MONDAY_BOARDS, MONDAY_STYLE_COLS, MONDAY_PRE_ORDER_COLS } from "@/lib/monday/boards";
import { ghostItemToMondayItem } from "@/lib/monday/sink";
import {
  BLANK_BA_VALUES,
  buildCustomerTokenIndex,
  extractLeadingToken,
  extractLinkedItemId,
  readGhostColumnText,
  readGhostColumnValue,
} from "./heuristics";

export type PromoteInput = {
  ghostItemId: string;
  customerId: string;
};

export type PromoteResult = {
  styleId: string;
  alreadyExisted: boolean;
  prodSpecId: string | null;
  completionPct: number;
  jobEnqueued: boolean;
};

export class PromoteError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ghost_item_not_found"
      | "customer_not_found"
      | "customer_not_a_candidate"
      | "unknown_board",
  ) {
    super(message);
    this.name = "PromoteError";
  }
}

// Resolve the per-board column ids for the ghost item's source board.
// Throws if the board id isn't one we scan — we don't promote items from
// boards we haven't characterised (no idea where BA / PO live).
function columnsForBoard(mondayBoardId: string): {
  baColumnId: string;
  customerLinkColumnId: string;
  poNumberColumnId: string;
} {
  if (mondayBoardId === MONDAY_BOARDS.styles) {
    return {
      baColumnId: MONDAY_STYLE_COLS.businessArea || "__business_area__1",
      customerLinkColumnId: MONDAY_STYLE_COLS.customerLink,
      poNumberColumnId: MONDAY_STYLE_COLS.poNumber,
    };
  }
  if (mondayBoardId === MONDAY_BOARDS.preOrder) {
    return {
      baColumnId: MONDAY_PRE_ORDER_COLS.businessArea,
      customerLinkColumnId: MONDAY_PRE_ORDER_COLS.customerLink,
      poNumberColumnId: MONDAY_PRE_ORDER_COLS.poNumber,
    };
  }
  throw new PromoteError(`Unknown source board ${mondayBoardId}`, "unknown_board");
}

// MondayItem-shape synthesis from a ghost row lives in sink.ts as
// ghostItemToMondayItem and is shared with the Fill flow.

export async function promoteGhostToStyle(input: PromoteInput): Promise<PromoteResult> {
  // ---------- Load ghost row ----------
  const ghost = await db.mondayGhostItem.findUnique({
    where: { id: input.ghostItemId },
    include: { board: { select: { mondayBoardId: true } } },
  });
  if (!ghost) {
    throw new PromoteError(`ghost item ${input.ghostItemId} not found`, "ghost_item_not_found");
  }

  const mondayBoardId = ghost.board.mondayBoardId;
  const cols = columnsForBoard(mondayBoardId);

  // ---------- Validate customer choice ----------
  // Server re-runs the trie + customerLink resolution and confirms the
  // caller's customerId is a legitimate candidate. Prevents a tampered
  // client from promoting any ghost item against any customer.
  const customer = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) {
    throw new PromoteError(`customer ${input.customerId} not found`, "customer_not_found");
  }

  const linkedCustomerMondayId = cols.customerLinkColumnId
    ? extractLinkedItemId(readGhostColumnValue(ghost.columnValues, cols.customerLinkColumnId))
    : null;
  let isValidCandidate = false;
  if (linkedCustomerMondayId && customer.mondayItemId === linkedCustomerMondayId) {
    isValidCandidate = true;
  } else {
    const token = extractLeadingToken(ghost.name);
    if (token) {
      const customers = await db.customer.findMany({
        where: { active: true },
        select: { id: true, name: true },
      });
      const trie = buildCustomerTokenIndex(customers);
      const matches = trie.get(token.toLowerCase()) ?? [];
      isValidCandidate = matches.some((m) => m.id === input.customerId);
    }
  }
  if (!isValidCandidate) {
    throw new PromoteError(
      `customer ${input.customerId} is not a candidate for ghost item ${input.ghostItemId}`,
      "customer_not_a_candidate",
    );
  }

  // ---------- Resolve BA ----------
  const baText = readGhostColumnText(ghost.columnValues, cols.baColumnId);
  let businessAreaId: string | null = null;
  let baMondayValue: string | null = null;
  if (baText && !BLANK_BA_VALUES.has(baText)) {
    const ba =
      (await db.businessArea.findFirst({
        where: { mondayValue: { equals: baText, mode: "insensitive" } },
      })) ??
      (await db.businessArea.findFirst({
        where: { name: { equals: baText, mode: "insensitive" } },
      }));
    if (ba) {
      businessAreaId = ba.id;
      baMondayValue = ba.mondayValue;
    } else {
      // Unknown BA text — keep the raw label as a free-text fallback so
      // it shows up on the Style detail page and the existing "Relink
      // Business Area" button can pick it up later.
      baMondayValue = baText;
    }
  }

  // ---------- Resolve PO number ----------
  const poNumber = cols.poNumberColumnId
    ? readGhostColumnText(ghost.columnValues, cols.poNumberColumnId)
    : null;

  // ---------- Resolve / ensure ProdSpec ----------
  let prodSpecId: string | null = null;
  let autoGenerateThresholdPct = 100;
  let prodSpecActive = false;
  let prodSpecRequiredFields: ReturnType<typeof parseProdSpecRequiredFields> = [];
  if (businessAreaId) {
    await ensureProdSpecsForStyle(customer.id, businessAreaId);
    const prodSpec = await db.prodSpec.findUnique({
      where: {
        customerId_businessAreaId: { customerId: customer.id, businessAreaId },
      },
    });
    if (prodSpec) {
      prodSpecId = prodSpec.id;
      autoGenerateThresholdPct = prodSpec.autoGenerateThresholdPct;
      prodSpecActive = prodSpec.active;
      prodSpecRequiredFields = parseProdSpecRequiredFields(prodSpec.requiredFields);
    }
  }

  // ---------- Evaluate completion ----------
  const customerConfig = parseCustomerConfig(customer.config);
  const requiredFields =
    prodSpecRequiredFields.length > 0 ? prodSpecRequiredFields : customerConfig.requiredFields;

  const synthetic = ghostItemToMondayItem(ghost, mondayBoardId);
  const { completionPct, missingFields } = evaluateCompletion(synthetic, requiredFields);
  const status = completionPct === 100 ? "READY" : "PENDING";

  // ---------- Detect "did this Style already exist?" before upsert ----------
  const preExisting = await db.style.findUnique({
    where: { mondayItemId: ghost.mondayItemId },
    select: { id: true },
  });

  // ---------- Upsert Style ----------
  const style = await db.style.upsert({
    where: { mondayItemId: ghost.mondayItemId },
    create: {
      customerId: customer.id,
      businessAreaId,
      supplierId: null,
      prodSpecId,
      mondayItemId: ghost.mondayItemId,
      mondayBoardId,
      name: ghost.name,
      businessArea: baMondayValue,
      poNumber,
      styleFolderUrl: null,
      rawData: synthetic as unknown as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      status,
      lastSyncedAt: new Date(),
    },
    update: {
      customerId: customer.id,
      businessAreaId,
      prodSpecId,
      mondayBoardId,
      name: ghost.name,
      businessArea: baMondayValue,
      poNumber,
      rawData: synthetic as unknown as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      status,
      lastSyncedAt: new Date(),
      // supplierId / styleFolderUrl deliberately omitted from update so
      // operator edits on Style detail aren't clobbered on re-promote.
    },
  });

  // ---------- Backfill any other Styles for the pair ----------
  if (businessAreaId) {
    await backfillStyleProdSpecLinks(customer.id, businessAreaId);
  }

  // ---------- Conditionally enqueue a Job ----------
  // Same in-flight gate as src/app/api/webhooks/monday/route.ts:90-98.
  // Caller is responsible for calling triggerRunner() once at the end of
  // the bulk operation — we don't fire it per item.
  // Gated by the global auto-generate master switch, same as the webhook
  // path. When off, promotion still creates/refreshes the Style; it just
  // doesn't fire a Job.
  let jobEnqueued = false;
  if (
    prodSpecId &&
    prodSpecActive &&
    completionPct >= autoGenerateThresholdPct &&
    // Flag + required-detail-fields read last so a bulk promote only hits
    // those for items that are otherwise eligible, not every ghost.
    (await getAutoGenerateEnabled()) &&
    (await hasAllRequiredDetailFields(style.id))
  ) {
    const inflight = await db.job.count({
      where: { styleId: style.id, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (inflight === 0) {
      await enqueueGenerationJob({ styleId: style.id, triggerSource: "MANUAL_IMPORT" });
      jobEnqueued = true;
    }
  }

  return {
    styleId: style.id,
    alreadyExisted: Boolean(preExisting),
    prodSpecId,
    completionPct,
    jobEnqueued,
  };
}

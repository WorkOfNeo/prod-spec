import { db } from "@/lib/db";
import {
  columnText,
  columnValue,
  type MondayItem,
} from "./client";
import {
  MONDAY_BOARDS,
  MONDAY_CUSTOMER_COLS,
  MONDAY_SUPPLIER_COLS,
  MONDAY_STYLE_COLS,
  MONDAY_PRE_ORDER_COLS,
} from "./boards";
import { ingestMondayItem, IngestSkip } from "./ingest";
import { ghostItemToMondayItem } from "./sink";
import { ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";
import { slog, serr, errorSampler } from "./sync-log";
import {
  extractLinkedItemId,
  readGhostColumnText,
  readGhostColumnValue,
} from "@/lib/import/heuristics";
import type { SyncKind } from "@/generated/prisma/enums";

// Load ghost-board metadata for a known Monday board id. Throws a
// readable error when the ghost mirror is empty so the operator sees
// "run Sync first" instead of a silent no-op.
async function getGhostBoardOrThrow(mondayBoardId: string, label: string) {
  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId },
    select: { id: true, mondayBoardId: true, name: true, lastSyncedAt: true },
  });
  if (!board) {
    throw new Error(
      `${label} ghost mirror is empty — run Sync (${label}) first to populate the ghost tables before Filling.`,
    );
  }
  return board;
}

// =====================================================
// Monday → local mirror sync.
//
// Each public function does:
//   1. open a SyncJob row (RUNNING)
//   2. page through the source board
//   3. upsert mirrored rows
//   4. mark rows whose source disappeared as `active = false`
//      (legacy rows without a mondayItemId are left alone)
//   5. close the SyncJob row (COMPLETED or FAILED)
//
// We never *delete* mirror rows. Customer/Supplier/BusinessArea rows
// flagged inactive remain in the DB and continue to back any historical
// Style references. This mirrors the webhook deletion rule.
// =====================================================

export type SyncResult = {
  syncJobId: string;
  itemsTotal: number;
  itemsSynced: number;
  itemsFailed: number;
  // Items the sync deliberately did not promote because operator action
  // is needed (e.g. ambiguous customer match). Tracked separately so
  // dashboards don't read "broken" when the situation is "needs review".
  itemsSkipped: number;
};

async function withSyncJob<T extends Omit<SyncResult, "syncJobId">>(
  kind: SyncKind,
  fn: (
    recordProgress: (
      synced: number,
      failed: number,
      total: number,
      skipped?: number,
    ) => Promise<void>,
  ) => Promise<T>,
): Promise<SyncResult> {
  const job = await db.syncJob.create({ data: { kind, status: "RUNNING" } });
  slog("fill", `${kind} start`);
  const recordProgress = async (
    synced: number,
    failed: number,
    total: number,
    skipped = 0,
  ) => {
    await db.syncJob.update({
      where: { id: job.id },
      data: { itemsSynced: synced, itemsFailed: failed, itemsTotal: total, itemsSkipped: skipped },
    });
  };
  try {
    const result = await fn(recordProgress);
    await db.syncJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        itemsSynced: result.itemsSynced,
        itemsFailed: result.itemsFailed,
        itemsSkipped: result.itemsSkipped,
        itemsTotal: result.itemsTotal,
      },
    });
    slog("fill", `${kind} done`, {
      synced: result.itemsSynced,
      failed: result.itemsFailed,
      skipped: result.itemsSkipped,
      total: result.itemsTotal,
    });
    return { syncJobId: job.id, ...result };
  } catch (err) {
    serr("fill", `${kind} FAILED`, err);
    await db.syncJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: (err as Error).message },
    });
    throw err;
  }
}

// fetchAllItems used to paginate Monday's GraphQL API for Fill. After
// the ghost-driven refactor (Fill = DB → DB), all paginated fetching
// happens inside sinkBoard. Kept removed to avoid the temptation of
// re-introducing live-API reads outside Sync.

// -----------------------------------------------------
// Customers (board 3317892788)
// -----------------------------------------------------

// Single-item upsert — reused by both the bulk sync and the webhook router.
export async function upsertCustomerFromMondayItem(item: MondayItem): Promise<void> {
  const accountName = MONDAY_CUSTOMER_COLS.account
    ? columnText(item, MONDAY_CUSTOMER_COLS.account) || item.name
    : item.name;
  const base = slugify(accountName) || `monday-${item.id}`;

  await db.customer.upsert({
    where: { mondayItemId: item.id },
    create: {
      slug: await uniqueSlug(base, item.id),
      mondayItemId: item.id,
      name: accountName,
      priority: MONDAY_CUSTOMER_COLS.priority ? columnText(item, MONDAY_CUSTOMER_COLS.priority) || null : null,
      salesResponsible: MONDAY_CUSTOMER_COLS.salesResponsible ? columnText(item, MONDAY_CUSTOMER_COLS.salesResponsible) || null : null,
      country: MONDAY_CUSTOMER_COLS.country ? columnText(item, MONDAY_CUSTOMER_COLS.country) || null : null,
      location: MONDAY_CUSTOMER_COLS.location ? columnText(item, MONDAY_CUSTOMER_COLS.location) || null : null,
      lastSyncedAt: new Date(),
      active: true,
    },
    update: {
      name: accountName,
      priority: MONDAY_CUSTOMER_COLS.priority ? columnText(item, MONDAY_CUSTOMER_COLS.priority) || null : undefined,
      salesResponsible: MONDAY_CUSTOMER_COLS.salesResponsible ? columnText(item, MONDAY_CUSTOMER_COLS.salesResponsible) || null : undefined,
      country: MONDAY_CUSTOMER_COLS.country ? columnText(item, MONDAY_CUSTOMER_COLS.country) || null : undefined,
      location: MONDAY_CUSTOMER_COLS.location ? columnText(item, MONDAY_CUSTOMER_COLS.location) || null : undefined,
      lastSyncedAt: new Date(),
      active: true,
    },
  });
}

export async function syncCustomers(): Promise<SyncResult> {
  return withSyncJob("CUSTOMERS", async (recordProgress) => {
    // Read from the ghost mirror instead of Monday's API. Run Sync first
    // to refresh ghost — Fill is now a pure DB → DB transform, so it's
    // safe to re-run as often as you want.
    const board = await getGhostBoardOrThrow(MONDAY_BOARDS.customers, "Customers");
    const ghostItems = await db.mondayGhostItem.findMany({
      where: { boardId: board.id },
      select: {
        mondayItemId: true,
        name: true,
        groupId: true,
        groupTitle: true,
        columnValues: true,
      },
    });
    let synced = 0;
    let failed = 0;
    const remoteIds = new Set<string>();
    const errs = errorSampler("fill:customers");
    slog("fill:customers", "items", { total: ghostItems.length });

    await recordProgress(0, 0, ghostItems.length, 0);

    for (const ghost of ghostItems) {
      try {
        const item = ghostItemToMondayItem(ghost, MONDAY_BOARDS.customers);
        await upsertCustomerFromMondayItem(item);
        remoteIds.add(item.id);
        synced++;
      } catch (err) {
        failed++;
        errs.record(`customer ${ghost.mondayItemId} (${ghost.name})`, err);
      }
      await recordProgress(synced, failed, ghostItems.length);
      if ((synced + failed) % 500 === 0) {
        slog("fill:customers", "progress", { done: synced + failed, total: ghostItems.length, failed });
      }
    }
    errs.done();

    // Mark customers we couldn't find in the ghost mirror as inactive —
    // but only those that originated from Monday. Legacy hand-rolled
    // rows (e.g. the manual-form `netto-germany`) stay untouched.
    // Caveat: if the ghost mirror is stale, a newly-added-on-Monday
    // customer will be missing here AND not yet in our table, so this
    // never incorrectly inactivates them. The only failure mode is
    // running Fill against a Sync that errored out mid-way — re-run
    // Sync to fix.
    await db.customer.updateMany({
      where: {
        mondayItemId: { not: null },
        NOT: { mondayItemId: { in: Array.from(remoteIds) } },
      },
      data: { active: false },
    });

    return { itemsTotal: ghostItems.length, itemsSynced: synced, itemsFailed: failed, itemsSkipped: 0 };
  });
}

// -----------------------------------------------------
// Suppliers (board 3363275451)
// -----------------------------------------------------

export async function upsertSupplierFromMondayItem(item: MondayItem): Promise<void> {
  const readCol = (id: string) => (id ? columnText(item, id) || null : null);
  const linkVal = (id: string): string | null => {
    if (!id) return null;
    return extractLinkUrl(columnValue(item, id)) || columnText(item, id) || null;
  };

  await db.supplier.upsert({
    where: { mondayItemId: item.id },
    create: {
      mondayItemId: item.id,
      name: item.name,
      purchaser: readCol(MONDAY_SUPPLIER_COLS.purchaser),
      address: readCol(MONDAY_SUPPLIER_COLS.address),
      location: readCol(MONDAY_SUPPLIER_COLS.location),
      postCode: readCol(MONDAY_SUPPLIER_COLS.postCode),
      country: readCol(MONDAY_SUPPLIER_COLS.country),
      sharepointUrl: linkVal(MONDAY_SUPPLIER_COLS.sharepointUrl),
      email: readCol(MONDAY_SUPPLIER_COLS.email),
      contactEmail: readCol(MONDAY_SUPPLIER_COLS.contactEmail),
      contactName: readCol(MONDAY_SUPPLIER_COLS.contactName),
      lastSyncedAt: new Date(),
      active: true,
    },
    update: {
      name: item.name,
      purchaser: MONDAY_SUPPLIER_COLS.purchaser ? readCol(MONDAY_SUPPLIER_COLS.purchaser) : undefined,
      address: MONDAY_SUPPLIER_COLS.address ? readCol(MONDAY_SUPPLIER_COLS.address) : undefined,
      location: MONDAY_SUPPLIER_COLS.location ? readCol(MONDAY_SUPPLIER_COLS.location) : undefined,
      postCode: MONDAY_SUPPLIER_COLS.postCode ? readCol(MONDAY_SUPPLIER_COLS.postCode) : undefined,
      country: MONDAY_SUPPLIER_COLS.country ? readCol(MONDAY_SUPPLIER_COLS.country) : undefined,
      sharepointUrl: MONDAY_SUPPLIER_COLS.sharepointUrl ? linkVal(MONDAY_SUPPLIER_COLS.sharepointUrl) : undefined,
      email: MONDAY_SUPPLIER_COLS.email ? readCol(MONDAY_SUPPLIER_COLS.email) : undefined,
      contactEmail: MONDAY_SUPPLIER_COLS.contactEmail ? readCol(MONDAY_SUPPLIER_COLS.contactEmail) : undefined,
      contactName: MONDAY_SUPPLIER_COLS.contactName ? readCol(MONDAY_SUPPLIER_COLS.contactName) : undefined,
      lastSyncedAt: new Date(),
      active: true,
    },
  });
}

export async function syncSuppliers(): Promise<SyncResult> {
  return withSyncJob("SUPPLIERS", async (recordProgress) => {
    const board = await getGhostBoardOrThrow(MONDAY_BOARDS.suppliers, "Suppliers");
    const ghostItems = await db.mondayGhostItem.findMany({
      where: { boardId: board.id },
      select: {
        mondayItemId: true,
        name: true,
        groupId: true,
        groupTitle: true,
        columnValues: true,
      },
    });
    let synced = 0;
    let failed = 0;
    const remoteIds = new Set<string>();
    const errs = errorSampler("fill:suppliers");
    slog("fill:suppliers", "items", { total: ghostItems.length });

    await recordProgress(0, 0, ghostItems.length, 0);

    for (const ghost of ghostItems) {
      try {
        const item = ghostItemToMondayItem(ghost, MONDAY_BOARDS.suppliers);
        await upsertSupplierFromMondayItem(item);
        remoteIds.add(item.id);
        synced++;
      } catch (err) {
        failed++;
        errs.record(`supplier ${ghost.mondayItemId} (${ghost.name})`, err);
      }
      await recordProgress(synced, failed, ghostItems.length);
      if ((synced + failed) % 500 === 0) {
        slog("fill:suppliers", "progress", { done: synced + failed, total: ghostItems.length, failed });
      }
    }
    errs.done();

    await db.supplier.updateMany({
      where: { NOT: { mondayItemId: { in: Array.from(remoteIds) } } },
      data: { active: false },
    });

    return {
      itemsTotal: ghostItems.length,
      itemsSynced: synced,
      itemsFailed: failed,
      itemsSkipped: 0,
    };
  });
}

// -----------------------------------------------------
// Business Areas — dropdown column on the Styles board.
//
// Two sources, in priority order:
//   1. The dropdown column's `settings_str` (authoritative)
//   2. Distinct values seen on Style items (fallback when col id unset)
// -----------------------------------------------------

export async function syncBusinessAreas(): Promise<SyncResult> {
  return withSyncJob("BUSINESS_AREAS", async (recordProgress) => {
    const labels = new Set<string>();

    // Source #1: dropdown labels from the ghost-mirrored Styles board
    // column. Sync already pulls these via Monday API and stores them
    // in MondayGhostDropdownOption — Fill just consumes the cache.
    if (MONDAY_STYLE_COLS.businessArea) {
      const stylesBoard = await db.mondayGhostBoard.findUnique({
        where: { mondayBoardId: MONDAY_BOARDS.styles },
        select: { id: true },
      });
      if (stylesBoard) {
        const baColumn = await db.mondayGhostColumn.findUnique({
          where: {
            boardId_mondayColumnId: {
              boardId: stylesBoard.id,
              mondayColumnId: MONDAY_STYLE_COLS.businessArea,
            },
          },
          select: { id: true },
        });
        if (baColumn) {
          const options = await db.mondayGhostDropdownOption.findMany({
            where: { boardColumnId: baColumn.id },
            select: { label: true },
          });
          for (const o of options) if (o.label) labels.add(o.label);
        }
      }
    }

    // Source #2: distinct values seen on Style items currently in the
    // mirror — catches BA values that exist on items even if the
    // dropdown settings haven't been sunk.
    const stylesWithBA = await db.style.findMany({
      where: { businessArea: { not: null } },
      select: { businessArea: true },
      distinct: ["businessArea"],
    });
    for (const s of stylesWithBA) if (s.businessArea) labels.add(s.businessArea);

    const remoteValues = Array.from(labels);
    let synced = 0;
    await recordProgress(0, 0, remoteValues.length, 0);
    for (const value of remoteValues) {
      await db.businessArea.upsert({
        where: { mondayValue: value },
        create: { mondayValue: value, name: value, lastSyncedAt: new Date(), active: true },
        update: { lastSyncedAt: new Date(), active: true },
      });
      synced++;
      await recordProgress(synced, 0, remoteValues.length);
    }

    // Don't auto-deactivate BA rows that disappeared — operators may have
    // renamed `name` and we'd lose their override. Only the explicit admin
    // BA management page can flip `active`.

    return { itemsTotal: remoteValues.length, itemsSynced: synced, itemsFailed: 0, itemsSkipped: 0 };
  });
}

// -----------------------------------------------------
// Styles — sourced from the Pre-Order board (7322835224). Delegates to the
// same `ingestMondayItem` the webhook receiver uses, so we exercise the
// same code path. (Was the Styles board 6979419195; Pre-Order is now the
// source of truth — it carries customer/supplier/PO/BA/folder + all the
// product fields natively.)
// -----------------------------------------------------

export async function syncStyles(): Promise<SyncResult> {
  return withSyncJob("STYLES", async (recordProgress) => {
    const board = await getGhostBoardOrThrow(MONDAY_BOARDS.preOrder, "Pre Order");
    const ghostItems = await db.mondayGhostItem.findMany({
      where: { boardId: board.id },
      select: {
        mondayItemId: true,
        name: true,
        groupId: true,
        groupTitle: true,
        columnValues: true,
      },
    });
    let synced = 0;
    let failed = 0;
    let skipped = 0;
    const errs = errorSampler("fill:styles");
    slog("fill:styles", "items", { total: ghostItems.length });
    await recordProgress(0, 0, ghostItems.length, 0);

    for (const ghost of ghostItems) {
      try {
        const item = ghostItemToMondayItem(ghost, MONDAY_BOARDS.preOrder);
        await ingestMondayItem(ghost.mondayItemId, item);
        synced++;
      } catch (err) {
        // IngestSkip = "needs operator action" (ambiguous / unmatched
        // customer). Track separately from real errors so dashboards
        // don't read "broken" when the situation is "needs review".
        if (err instanceof IngestSkip) {
          skipped++;
        } else {
          failed++;
          errs.record(`style ${ghost.mondayItemId} (${ghost.name})`, err);
        }
      }
      await recordProgress(synced, failed, ghostItems.length, skipped);
      if ((synced + failed + skipped) % 500 === 0) {
        slog("fill:styles", "progress", {
          done: synced + failed + skipped,
          total: ghostItems.length,
          failed,
          skipped,
        });
      }
    }
    errs.done();

    return {
      itemsTotal: ghostItems.length,
      itemsSynced: synced,
      itemsFailed: failed,
      itemsSkipped: skipped,
    };
  });
}

// -----------------------------------------------------
// sync-all — runs each in dependency order, then auto-creates ProdSpec
// rows for any (Customer × BA) combo seen in Style rows that doesn't
// already have one.
// -----------------------------------------------------

export type SyncAllResult = {
  syncJobId: string;
  customers: SyncResult;
  suppliers: SyncResult;
  businessAreas: SyncResult;
  styles: SyncResult;
  prodSpecsCreated: number;
  enrichment: EnrichmentResult;
};

export type EnrichmentResult = {
  preOrderItemsScanned: number;
  preOrderItemsMatched: number;
  stylesUpdated: number;
};

// Pre-Order ghost columns we lift onto matching Styles. Stored in
// Style.rawData.column_values with a "po." prefix so the renderer's
// columnText() helper picks them up via DEFAULT_COLUMN_MAPPING without
// changes, and never collides with same-id columns on the Styles board
// (e.g. text2__1 means GSM on Styles, Qty/Carton on Pre-Order).
const PRE_ORDER_ENRICHMENT_COLUMNS = [
  "sizes__1", // Sizes (dropdown)
  "dropdown_mktbzd1f", // Wash Care Symbols (dropdown)
  "numeric_mktagw13", // Lot No
  "text2__1", // Qty/Carton (text)
  "numeric_mktagpmg", // Carton Barcode number
  "text76__1", // Size Ratio
  "text64__1", // Composition (Pre-Order's, richer than Styles)
  "text_mktbv53f", // 2nd Composition
  "text_mktbynx8", // Color Name From Client
  "mirror__1", // 🌍 Country of Origin (mirror → factory/supplier country; value in display_value)
  // Runsven prior-solution master fields (Sheet1) — lifted so they surface
  // on the Details tab and feed the printable outputs.
  "text91__1", // 🔑 Customer Item No
  "numeric_mkta3mqk", // Barcode Number
  "numeric_mkta7tzg", // Batch nr
  "status87__1", // 🎯 Target Group (Buying Dept)
  "customer_order_number__1", // 🔢 Customer Order Number
  "long_text_mkrvd8j3", // Description
  "text_mkv0ebfg", // KL No.
  "numeric_mkta1jd5", // Prod number
  "text33__1", // 📅 Campaign Week
  "retail_prices__1", // Retail Prices
  "numeric_mkta4201", // Sales unit
  "dropdown4__1", // 👜 Trims
] as const;

// Run after syncStyles. For every Pre-Order ghost item, resolve its
// (customerId, poNumber) and merge the columns above onto matching
// Style rows. Multiple Styles can share a PO (a single order covers
// many products) — we apply the same Pre-Order data to each match.
//
// Idempotent: stale "po." entries are stripped before re-merging so
// re-runs always reflect the latest Pre-Order sink.
export async function enrichStylesFromPreOrder(): Promise<EnrichmentResult> {
  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: MONDAY_BOARDS.preOrder },
  });
  if (!board) {
    return { preOrderItemsScanned: 0, preOrderItemsMatched: 0, stylesUpdated: 0 };
  }

  const ghostItems = await db.mondayGhostItem.findMany({
    where: { boardId: board.id },
    select: { id: true, mondayItemId: true, name: true, columnValues: true },
  });

  // Map linked-Monday-customer-id → local Customer.id. Pre-Order's
  // customer__1 holds the same kind of board-relation IDs the Styles
  // board uses; we resolve them through the local Customer mirror.
  const customers = await db.customer.findMany({
    where: { active: true, mondayItemId: { not: null } },
    select: { id: true, mondayItemId: true },
  });
  const customerByMondayId = new Map(
    customers.map((c) => [c.mondayItemId as string, c.id]),
  );

  const customerLinkCol = MONDAY_PRE_ORDER_COLS.customerLink || "customer__1";
  const poNumberCol = MONDAY_PRE_ORDER_COLS.poNumber || "text44__1";

  let preOrderItemsMatched = 0;
  let stylesUpdated = 0;

  for (const ghost of ghostItems) {
    // Resolve customer
    const linkedCustomerMondayId = extractLinkedItemId(
      readGhostColumnValue(ghost.columnValues, customerLinkCol),
    );
    if (!linkedCustomerMondayId) continue;
    const customerId = customerByMondayId.get(linkedCustomerMondayId);
    if (!customerId) continue;

    // Resolve PO number
    const poNumber = readGhostColumnText(ghost.columnValues, poNumberCol);
    if (!poNumber) continue;

    // Find matching Styles
    const styles = await db.style.findMany({
      where: { customerId, poNumber },
      select: { id: true, rawData: true },
    });
    if (styles.length === 0) continue;
    preOrderItemsMatched++;

    // Pick the relevant Pre-Order column values, prefix the ids.
    const cvs = Array.isArray(ghost.columnValues) ? ghost.columnValues : [];
    const wanted = new Set<string>(PRE_ORDER_ENRICHMENT_COLUMNS);
    type RawCv = { id?: unknown; type?: unknown; text?: unknown; value?: unknown; display_value?: unknown };
    const enrichedColumns = (cvs as RawCv[])
      .filter(
        (cv): cv is RawCv & { id: string } =>
          typeof cv?.id === "string" && wanted.has(cv.id),
      )
      .map((cv) => ({
        id: "po." + cv.id,
        type: typeof cv.type === "string" ? cv.type : null,
        // Mirror columns (e.g. Country of Origin) arrive here with their
        // value already folded into `text` by the sink's
        // serializeColumnValues (Monday returns empty text + display_value).
        text: typeof cv.text === "string" ? cv.text : null,
        value:
          cv.value == null
            ? null
            : typeof cv.value === "string"
              ? cv.value
              : JSON.stringify(cv.value),
      }));

    // The Pre-Order row's NAME is the Contrast style number (IL-code, e.g.
    // "IL63353") — it's the item name, not a column. Lift it as a synthetic
    // po.__name__ column so styleNumber can map to it.
    if (typeof ghost.name === "string" && ghost.name.trim()) {
      enrichedColumns.push({ id: "po.__name__", type: "name", text: ghost.name, value: null });
    }

    if (enrichedColumns.length === 0) continue;

    for (const style of styles) {
      const raw = (style.rawData ?? {}) as { column_values?: unknown };
      const existing = Array.isArray(raw.column_values) ? (raw.column_values as RawCv[]) : [];
      // Strip stale "po." entries before re-merging — keeps re-runs
      // truthful to the latest Pre-Order sink.
      const cleaned = existing.filter(
        (cv) => !(typeof cv?.id === "string" && cv.id.startsWith("po.")),
      );
      const merged = [...cleaned, ...enrichedColumns];
      await db.style.update({
        where: { id: style.id },
        data: { rawData: { ...raw, column_values: merged } as object },
      });
      stylesUpdated++;
    }
  }

  return {
    preOrderItemsScanned: ghostItems.length,
    preOrderItemsMatched,
    stylesUpdated,
  };
}

export async function syncAll(): Promise<SyncAllResult> {
  const overall = await db.syncJob.create({ data: { kind: "ALL", status: "RUNNING" } });
  slog("fill:all", "start");
  try {
    const customers = await syncCustomers();
    const suppliers = await syncSuppliers();
    const businessAreas = await syncBusinessAreas();
    const styles = await syncStyles();
    slog("fill:all", "domains done", {
      customers: customers.itemsSynced,
      suppliers: suppliers.itemsSynced,
      businessAreas: businessAreas.itemsSynced,
      styles: styles.itemsSynced,
    });

    // Auto-create ProdSpec rows for every (Customer × BA) combo seen on
    // Style rows. Idempotent — skips combos that already exist.
    const styleRows = await db.style.findMany({
      where: { businessAreaId: { not: null } },
      select: { id: true, customerId: true, businessAreaId: true },
    });
    let prodSpecsCreated = 0;
    for (const s of styleRows) {
      const created = await ensureProdSpecsForStyle(s.customerId, s.businessAreaId!);
      if (created) prodSpecsCreated++;
    }
    slog("fill:all", "prod specs created", { count: prodSpecsCreated });

    // Pre-Order is now the SOURCE of Style rows (syncStyles reads it
    // directly), so the old "merge Pre-Order columns onto Styles-board
    // styles" enrichment step is retired — its data lands natively at
    // ingest. Kept as a zero-result so the SyncAllResult shape is stable.
    const enrichment: EnrichmentResult = {
      preOrderItemsScanned: 0,
      preOrderItemsMatched: 0,
      stylesUpdated: 0,
    };

    await db.syncJob.update({
      where: { id: overall.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        itemsTotal: customers.itemsTotal + suppliers.itemsTotal + businessAreas.itemsTotal + styles.itemsTotal,
        itemsSynced: customers.itemsSynced + suppliers.itemsSynced + businessAreas.itemsSynced + styles.itemsSynced,
        itemsFailed: customers.itemsFailed + suppliers.itemsFailed + businessAreas.itemsFailed + styles.itemsFailed,
        itemsSkipped: customers.itemsSkipped + suppliers.itemsSkipped + businessAreas.itemsSkipped + styles.itemsSkipped,
      },
    });

    slog("fill:all", "done", {
      synced:
        customers.itemsSynced + suppliers.itemsSynced + businessAreas.itemsSynced + styles.itemsSynced,
      failed:
        customers.itemsFailed + suppliers.itemsFailed + businessAreas.itemsFailed + styles.itemsFailed,
      skipped:
        customers.itemsSkipped + suppliers.itemsSkipped + businessAreas.itemsSkipped + styles.itemsSkipped,
      prodSpecs: prodSpecsCreated,
    });

    return {
      syncJobId: overall.id,
      customers,
      suppliers,
      businessAreas,
      styles,
      prodSpecsCreated,
      enrichment,
    };
  } catch (err) {
    serr("fill:all", "FAILED", err);
    await db.syncJob.update({
      where: { id: overall.id },
      data: { status: "FAILED", finishedAt: new Date(), error: (err as Error).message },
    });
    throw err;
  }
}

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

// Slug collision handling: if the base slug already exists with a different
// mondayItemId, append a short suffix to keep it unique.
async function uniqueSlug(base: string, mondayItemId: string): Promise<string> {
  const existing = await db.customer.findUnique({ where: { slug: base } });
  if (!existing || existing.mondayItemId === mondayItemId) return base;
  return `${base}-${mondayItemId.slice(-6)}`;
}

function extractLinkUrl(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "url" in raw && typeof (raw as { url: unknown }).url === "string") {
    return (raw as { url: string }).url || null;
  }
  return null;
}

// extractDropdownLabels used to parse settings_str inline. After the
// ghost-driven refactor, sinkBoard parses the same shape into
// MondayGhostDropdownOption rows, and syncBusinessAreas reads from
// those. The parsing logic now lives only inside sink.ts.

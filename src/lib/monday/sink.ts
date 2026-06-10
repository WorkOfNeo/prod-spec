// Board-agnostic Monday → ghost-DB sink.
//
// Drops a full snapshot of a Monday board into the typeless mirror tables
// (MondayGhostBoard / MondayGhostColumn / MondayGhostItem /
// MondayGhostDropdownOption) so we can browse what's there before deciding
// how to fold it into the typed domain mirrors.
//
// Idempotent: every entity upserts by its Monday id, and the run stamps
// `lastSyncedAt` on every row it touched. Nothing is ever deleted (same
// rule as MondayWebhook — operators clean up by hand if needed).

import { db } from "@/lib/db";
import { MONDAY_BOARD_LABELS, MONDAY_BOARDS } from "./boards";
import { getBoardMeta, getBoardItems, getNextItemsPage } from "./client-pagination";
import type { MondayItem } from "./client";
import { slog, serr, errorSampler } from "./sync-log";

export type SinkResult = {
  boardId: string;
  mondayBoardName: string;
  itemsTotal: number;
  itemsSynced: number;
  itemsFailed: number;
  columnsSynced: number;
  dropdownOptionsSynced: number;
  durationMs: number;
};

export async function sinkBoard(boardId: string): Promise<SinkResult> {
  const startedAt = Date.now();
  const meta = await getBoardMeta(boardId);
  if (!meta) throw new Error(`Board ${boardId} not found on Monday`);
  slog("sink", "board start", { board: meta.id, name: meta.name });

  // Pick a friendly label if this board id matches one of our known keys.
  // Otherwise leave it null and let the operator name it from the UI.
  const knownKey = (Object.keys(MONDAY_BOARDS) as Array<keyof typeof MONDAY_BOARDS>).find(
    (k) => MONDAY_BOARDS[k] === boardId,
  );
  const label = knownKey ? MONDAY_BOARD_LABELS[knownKey] : null;

  // -----------------------------------------------------
  // Step 1 — upsert board metadata, then columns. Columns must land first
  // so the dropdown-option upsert (step 3) has a stable FK target.
  // -----------------------------------------------------
  const board = await db.mondayGhostBoard.upsert({
    where: { mondayBoardId: meta.id },
    create: {
      mondayBoardId: meta.id,
      name: meta.name,
      description: meta.description,
      label,
      lastSyncedAt: new Date(),
    },
    update: {
      name: meta.name,
      description: meta.description,
      // Only fill `label` from the known-board map if it's still empty —
      // don't clobber an operator's rename.
      ...(label ? { label } : {}),
      lastSyncedAt: new Date(),
    },
  });

  const now = new Date();
  let columnsSynced = 0;
  const columnIdMap = new Map<string, string>(); // mondayColumnId -> ghost column id

  for (const col of meta.columns) {
    const row = await db.mondayGhostColumn.upsert({
      where: { boardId_mondayColumnId: { boardId: board.id, mondayColumnId: col.id } },
      create: {
        boardId: board.id,
        mondayColumnId: col.id,
        title: col.title,
        type: col.type,
        description: col.description,
        settings: (col.settings ?? null) as object,
        lastSyncedAt: now,
      },
      update: {
        title: col.title,
        type: col.type,
        description: col.description,
        settings: (col.settings ?? null) as object,
        lastSyncedAt: now,
      },
    });
    columnIdMap.set(col.id, row.id);
    columnsSynced++;
  }
  slog("sink", "columns synced", { board: meta.id, columns: columnsSynced });

  // -----------------------------------------------------
  // Step 2 — page through items, batched in parallel chunks.
  //
  // Each upsert is its own roundtrip, so a sequential loop for the Pre
  // Order board (~5k items) burned ~15 min on Railway. Running them in
  // parallel chunks pushes the wall-clock down by roughly the chunk
  // size without overwhelming the connection pool — 20 concurrent
  // upserts fits comfortably in the default pool budget and keeps
  // failures bounded to a single chunk.
  // -----------------------------------------------------
  const ITEM_CHUNK = 20;
  let itemsTotal = 0;
  let itemsSynced = 0;
  let itemsFailed = 0;
  const itemErrors = errorSampler(`sink:${meta.id}`);

  let { items, cursor } = await getBoardItems(meta.id, 200);
  while (true) {
    itemsTotal += items.length;
    for (let i = 0; i < items.length; i += ITEM_CHUNK) {
      const chunk = items.slice(i, i + ITEM_CHUNK);
      const settled = await Promise.allSettled(
        chunk.map((item) => upsertGhostItem(board.id, item, now)),
      );
      settled.forEach((r, j) => {
        if (r.status === "fulfilled") {
          itemsSynced++;
        } else {
          itemsFailed++;
          itemErrors.record(`item ${chunk[j]?.id ?? "?"} upsert failed`, r.reason);
        }
      });
    }
    // One line per page (~200 items) so a long Pre-Order sink shows
    // liveness in the Railway log stream instead of looking hung.
    slog("sink", "items progress", {
      board: meta.id,
      total: itemsTotal,
      synced: itemsSynced,
      failed: itemsFailed,
    });
    if (!cursor) break;
    const next = await getNextItemsPage(cursor, 200);
    items = next.items;
    cursor = next.cursor;
  }
  itemErrors.done();

  // -----------------------------------------------------
  // Step 3 — flatten dropdown / status options into MondayGhostDropdownOption.
  // Same chunking strategy — even though options are typically < 200 per
  // board, the Pre Order board pushed 2.3k.
  // -----------------------------------------------------
  const OPTION_CHUNK = 25;
  const optionWrites: Array<() => Promise<unknown>> = [];
  for (const col of meta.columns) {
    if (col.type !== "dropdown" && col.type !== "status" && col.type !== "color") continue;
    const ghostColumnId = columnIdMap.get(col.id);
    if (!ghostColumnId) continue;
    for (const opt of extractOptions(col.settings)) {
      optionWrites.push(() =>
        db.mondayGhostDropdownOption.upsert({
          where: {
            boardColumnId_optionId: { boardColumnId: ghostColumnId, optionId: opt.id },
          },
          create: {
            boardColumnId: ghostColumnId,
            optionId: opt.id,
            label: opt.label,
            color: opt.color,
            lastSyncedAt: now,
          },
          update: {
            label: opt.label,
            color: opt.color,
            lastSyncedAt: now,
          },
        }),
      );
    }
  }
  let dropdownOptionsSynced = 0;
  for (let i = 0; i < optionWrites.length; i += OPTION_CHUNK) {
    const chunk = optionWrites.slice(i, i + OPTION_CHUNK);
    const settled = await Promise.allSettled(chunk.map((fn) => fn()));
    dropdownOptionsSynced += settled.filter((r) => r.status === "fulfilled").length;
  }

  // Close out — stamp itemCount + lastSyncedAt on the board.
  await db.mondayGhostBoard.update({
    where: { id: board.id },
    data: { itemCount: itemsTotal, lastSyncedAt: now },
  });

  slog("sink", "board done", {
    board: meta.id,
    items: `${itemsSynced}/${itemsTotal}`,
    failed: itemsFailed,
    columns: columnsSynced,
    options: dropdownOptionsSynced,
    ms: Date.now() - startedAt,
  });

  return {
    boardId: meta.id,
    mondayBoardName: meta.name,
    itemsTotal,
    itemsSynced,
    itemsFailed,
    columnsSynced,
    dropdownOptionsSynced,
    durationMs: Date.now() - startedAt,
  };
}

// Single-item upsert factored out so the webhook router can call it too
// once we wire ghost mirroring into the live event flow.
export async function upsertGhostItem(
  boardRowId: string,
  item: MondayItem,
  syncedAt: Date,
): Promise<void> {
  await db.mondayGhostItem.upsert({
    where: { boardId_mondayItemId: { boardId: boardRowId, mondayItemId: item.id } },
    create: {
      boardId: boardRowId,
      mondayItemId: item.id,
      name: item.name,
      groupId: item.group?.id ?? null,
      groupTitle: item.group?.title ?? null,
      columnValues: serializeColumnValues(item),
      lastSyncedAt: syncedAt,
    },
    update: {
      name: item.name,
      groupId: item.group?.id ?? null,
      groupTitle: item.group?.title ?? null,
      columnValues: serializeColumnValues(item),
      lastSyncedAt: syncedAt,
    },
  });
}

// Inverse of serializeColumnValues: take a MondayGhostItem row and
// re-synthesize a MondayItem shape that callers expecting the live API
// shape (ingest, customer/supplier upserts, promote) can consume. The
// stored ghost `value` is parsed JSON; the live MondayItem.value is a
// JSON string, so we re-stringify on the way out. Board-relation rows
// keep working because the sink already backfilled `linkedPulseIds`
// into `value` from `linked_item_ids` when sinking (see serialize-
// ColumnValues below).
import type { MondayColumnValue } from "./client";

export function ghostItemToMondayItem(
  ghost: {
    mondayItemId: string;
    name: string;
    columnValues: unknown;
    groupId?: string | null;
    groupTitle?: string | null;
  },
  mondayBoardId: string,
): MondayItem {
  const cvs = Array.isArray(ghost.columnValues) ? ghost.columnValues : [];
  const column_values: MondayColumnValue[] = cvs.map((cv) => {
    const c = (cv ?? {}) as { id?: unknown; type?: unknown; text?: unknown; value?: unknown };
    return {
      id: String(c.id ?? ""),
      type: typeof c.type === "string" ? c.type : undefined,
      text: typeof c.text === "string" ? c.text : null,
      value:
        c.value == null
          ? null
          : typeof c.value === "string"
            ? c.value
            : JSON.stringify(c.value),
    };
  });
  return {
    id: ghost.mondayItemId,
    name: ghost.name,
    board: { id: mondayBoardId },
    group: ghost.groupId
      ? { id: ghost.groupId, title: ghost.groupTitle ?? ghost.groupId }
      : null,
    column_values,
  };
}

// Monday returns `value` as a JSON string. We parse it eagerly so the
// stored shape is { id, type, text, value: parsed_or_null } — easier to
// query and inspect in the admin UI without re-parsing every render.
//
// Board-relation special case: Monday API 2024-10+ stops emitting
// `linkedPulseIds` in `value` and instead exposes the link via the
// `BoardRelationValue` GraphQL fragment (`linked_item_ids`). We
// synthesize the legacy `{ linkedPulseIds: [{ linkedPulseId }] }` shape
// into `value` when needed so downstream readers (extractLinkedItemId,
// suggestions wizard, /import scan, ingest customer-link resolution)
// keep working on a single shape regardless of how Monday returned it.
function serializeColumnValues(item: MondayItem): object {
  return item.column_values.map((cv) => {
    let value: unknown = null;
    if (cv.value) {
      try {
        value = JSON.parse(cv.value);
      } catch {
        value = cv.value;
      }
    }
    // Backfill from BoardRelationValue when the legacy `value` is empty.
    if (
      (value === null || value === undefined) &&
      Array.isArray(cv.linked_item_ids) &&
      cv.linked_item_ids.length > 0
    ) {
      value = {
        linkedPulseIds: cv.linked_item_ids.map((id) => ({ linkedPulseId: String(id) })),
      };
    }
    return {
      id: cv.id,
      type: cv.type ?? null,
      // Mirror columns return an empty STRING for `text` (not null), so a
      // `??` fallback would keep "" and drop the value — use a truthy check
      // so the mirror's `display_value` (e.g. "China") lands in `text`.
      text: cv.text && cv.text.trim() ? cv.text : (cv.display_value ?? null),
      value,
    };
  });
}

type DropdownOption = { id: string; label: string; color: string | null };

// Monday dropdown/status `settings_str` shapes vary:
//   dropdown → { "labels": [{ "id": 1, "name": "PL", "color": "#aaa" }, ...] }
//   status   → { "labels": { "0": "Working on it", "1": "Done", ... },
//                "labels_colors": { "0": { "color": "#fb275d", ... }, ... } }
//   color    → similar to dropdown (legacy alias)
function extractOptions(settings: unknown): DropdownOption[] {
  if (!settings || typeof settings !== "object") return [];
  const s = settings as { labels?: unknown; labels_colors?: unknown };
  const out: DropdownOption[] = [];

  if (Array.isArray(s.labels)) {
    for (const entry of s.labels) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { id?: unknown; name?: unknown; color?: unknown };
      if (e.id === undefined || e.name === undefined) continue;
      out.push({
        id: String(e.id),
        label: String(e.name),
        color: typeof e.color === "string" ? e.color : null,
      });
    }
    return out;
  }

  if (s.labels && typeof s.labels === "object") {
    const colors = (s.labels_colors && typeof s.labels_colors === "object"
      ? (s.labels_colors as Record<string, { color?: unknown }>)
      : {}) as Record<string, { color?: unknown }>;
    for (const [id, name] of Object.entries(s.labels as Record<string, unknown>)) {
      if (!name) continue;
      const c = colors[id]?.color;
      out.push({
        id,
        label: String(name),
        color: typeof c === "string" ? c : null,
      });
    }
  }

  return out;
}

// Sink every known board in declaration order. Returns one SinkResult per
// board attempted plus a `failed` array for boards that errored out.
//
// Tracks progress through a SyncJob row (kind = SINK_ALL) so the Monday
// admin page can poll /api/admin/sync/progress?kind=SINK_ALL and show
// "X / N boards done · Ms elapsed" while the run is in flight. itemsTotal
// = number of known boards; itemsSynced / itemsFailed advance per board.
export async function sinkAllKnownBoards(): Promise<{
  syncJobId: string;
  results: Array<SinkResult & { key: string }>;
  failed: Array<{ key: string; boardId: string; error: string }>;
}> {
  const { listKnownBoards } = await import("./boards");
  const boards = listKnownBoards();
  slog("sink-all", "start", { boards: boards.length });

  const job = await db.syncJob.create({
    data: {
      kind: "SINK_ALL",
      status: "RUNNING",
      itemsTotal: boards.length,
    },
  });

  const results: Array<SinkResult & { key: string }> = [];
  const failed: Array<{ key: string; boardId: string; error: string }> = [];
  try {
    for (const b of boards) {
      try {
        const r = await sinkBoard(b.id);
        results.push({ key: b.key, ...r });
      } catch (err) {
        // Keep going so one broken board doesn't block the rest — but log
        // the reason so it's visible instead of buried in `failed[]`.
        serr("sink-all", `board ${b.key} (${b.id}) failed`, err);
        failed.push({ key: b.key, boardId: b.id, error: (err as Error).message });
      }
      // Update after each board so the progress bar ticks up board-by-board.
      await db.syncJob.update({
        where: { id: job.id },
        data: { itemsSynced: results.length, itemsFailed: failed.length },
      });
    }
    await db.syncJob.update({
      where: { id: job.id },
      data: {
        status: failed.length > 0 && results.length === 0 ? "FAILED" : "COMPLETED",
        finishedAt: new Date(),
        itemsSynced: results.length,
        itemsFailed: failed.length,
      },
    });
    slog("sink-all", "done", { ok: results.length, failed: failed.length });
  } catch (err) {
    serr("sink-all", "run aborted", err);
    await db.syncJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: (err as Error).message },
    });
    throw err;
  }

  return { syncJobId: job.id, results, failed };
}

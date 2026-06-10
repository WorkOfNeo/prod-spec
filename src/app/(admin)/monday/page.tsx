// Single landing page for everything Monday — replaces /monday-inspect and
// /sync in the sidebar. Top-level tabs:
//
//   Inspector — live API introspection (existing /monday-inspect content)
//   Sync      — trigger domain mirror syncs + ghost-DB sinks
//   Data      — browse the ghost-DB tables (sub-tabs per board + Dropdowns)
//   Webhooks  — the append-only Monday webhook registry (moved from Settings)
//
// Tab state lives in `?tab=…` so the URL is shareable. Other search params
// (dataset, boardKey, …) are owned by the Data tab.

import Link from "next/link";
import { db } from "@/lib/db";
import { MONDAY_BOARDS, MONDAY_BOARD_LABELS, listKnownBoards } from "@/lib/monday/boards";
import { InspectorTab } from "./tabs/inspector-tab";
import { SyncTab } from "./tabs/sync-tab";
import { DataTab, ROW_PAGE_STEP, ROW_PAGE_MAX } from "./tabs/data-tab";
import { WebhooksTab } from "./tabs/webhooks-tab";

export const dynamic = "force-dynamic";

type TabKey = "inspector" | "sync" | "data" | "webhooks";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "inspector", label: "Inspector" },
  { key: "sync", label: "Sync" },
  { key: "data", label: "Data" },
  { key: "webhooks", label: "Webhooks" },
];

function parseTab(raw: string | undefined): TabKey {
  if (raw === "sync" || raw === "data" || raw === "webhooks") return raw;
  return "inspector";
}

export default async function MondayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = parseTab(typeof params.tab === "string" ? params.tab : undefined);

  // Pre-load the data the chosen tab needs. Each tab component receives
  // only what it cares about — the others stay cheap.
  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Monday</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Live API inspection, sync triggers, and a browsable mirror of every Monday board we know
          about.
        </p>
      </div>

      <nav className="mb-6 border-b border-zinc-200">
        <ul className="flex gap-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={`/monday?tab=${t.key}`}
                scroll={false}
                className={`inline-block border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === t.key
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-700"
                }`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "inspector" && (
        <InspectorTab
          knownBoards={listKnownBoards().map((b) => ({ id: b.id, label: b.label }))}
          initialBoardId={typeof params.boardId === "string" ? params.boardId : null}
        />
      )}

      {tab === "sync" && <SyncTabAsync />}

      {tab === "data" && (
        <DataTabAsync
          datasetParam={typeof params.dataset === "string" ? params.dataset : null}
          boardKeyParam={typeof params.boardKey === "string" ? params.boardKey : null}
          viewParam={typeof params.view === "string" ? params.view : null}
          rowsParam={typeof params.rows === "string" ? params.rows : null}
        />
      )}

      {tab === "webhooks" && <WebhooksTabAsync />}
    </div>
  );
}

async function WebhooksTabAsync() {
  const [webhooks, logs] = await Promise.all([
    db.mondayWebhook.findMany({ orderBy: { createdAt: "desc" } }),
    // Webhook activity comes from the Log table: the handler writes one
    // `monday.webhook …` line per inbound event, plus `failed to handle …`
    // rows on error. Pull the recent ones for the activity table.
    db.log.findMany({
      where: {
        OR: [
          { message: { startsWith: "monday.webhook" } },
          { message: { startsWith: "failed to handle event" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const boardLabelById = new Map(listKnownBoards().map((b) => [b.id, b.label]));

  return (
    <WebhooksTab
      webhooks={webhooks.map((w) => ({
        id: w.id,
        boardId: w.boardId,
        boardLabel: boardLabelById.get(w.boardId) ?? "Unknown board",
        eventType: w.eventType,
        mondayWebhookId: w.mondayWebhookId,
        createdAt: w.createdAt,
      }))}
      activity={logs.map((row) => normalizeWebhookLog(row, boardLabelById))}
    />
  );
}

// Parse a Log row into the readable shape the activity table renders.
// Primary events look like `monday.webhook <event> board=<id> pulse=<id>`;
// failures look like `failed to handle event for item <id>: <reason>`.
function normalizeWebhookLog(
  row: { id: string; message: string; level: string; payload: unknown; createdAt: Date },
  boardLabelById: Map<string, string>,
): {
  id: string;
  at: Date;
  level: string;
  event: string;
  board: string;
  item: string;
  detail: string;
} {
  const base = { id: row.id, at: row.createdAt, level: String(row.level) };
  const m = row.message;

  const primary = m.match(/^monday\.webhook (\S+) board=(\S+) pulse=(\S+)/);
  if (primary) {
    const [, event, boardId, pulse] = primary;
    return {
      ...base,
      event,
      board: boardId === "?" ? "—" : (boardLabelById.get(boardId) ?? boardId),
      item: pulse === "?" ? "—" : pulse,
      detail: "",
    };
  }

  const failure = m.match(/^failed to handle event for item (\S+): (.*)$/);
  if (failure) {
    const [, pulse, detail] = failure;
    const boardId =
      row.payload && typeof row.payload === "object" && "boardId" in row.payload
        ? String((row.payload as { boardId: unknown }).boardId)
        : null;
    return {
      ...base,
      event: "error",
      board: boardId ? (boardLabelById.get(boardId) ?? boardId) : "—",
      item: pulse,
      detail,
    };
  }

  // Other `monday.webhook …` info lines (board-event ignored / unknown board).
  return { ...base, event: "info", board: "—", item: "—", detail: m.replace(/^monday\.webhook /, "") };
}

// Async wrappers — `searchParams` is async-only in Next 16, so the
// data-loading happens inside an awaited child component.

async function SyncTabAsync() {
  const [recent, counts, ghostBoards] = await Promise.all([
    db.syncJob.findMany({ orderBy: { startedAt: "desc" }, take: 25 }),
    Promise.all([
      db.customer.count({ where: { active: true } }),
      db.supplier.count({ where: { active: true } }),
      db.businessArea.count({ where: { active: true } }),
      db.style.count(),
    ]).then(([customers, suppliers, businessAreas, styles]) => ({
      customers,
      suppliers,
      businessAreas,
      styles,
    })),
    db.mondayGhostBoard.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        mondayBoardId: true,
        name: true,
        label: true,
        itemCount: true,
        lastSyncedAt: true,
      },
    }),
  ]);

  return (
    <SyncTab
      recent={recent.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        itemsTotal: j.itemsTotal,
        itemsSynced: j.itemsSynced,
        itemsFailed: j.itemsFailed,
        itemsSkipped: j.itemsSkipped,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        error: j.error,
      }))}
      counts={counts}
      ghostBoards={ghostBoards.map((b) => ({
        ...b,
        lastSyncedAt: b.lastSyncedAt ?? null,
      }))}
      knownBoards={listKnownBoards()}
    />
  );
}

async function DataTabAsync({
  datasetParam,
  boardKeyParam,
  viewParam,
  rowsParam,
}: {
  datasetParam: string | null;
  boardKeyParam: string | null;
  viewParam: string | null;
  rowsParam: string | null;
}) {
  // How many data rows to load. Defaults to one page; "Load more" grows it
  // via the `rows` param, clamped to [STEP, MAX] so a hand-typed value
  // can't pull an unbounded result set.
  const parsedRows = rowsParam ? Number.parseInt(rowsParam, 10) : Number.NaN;
  const rowLimit = Number.isFinite(parsedRows)
    ? Math.min(Math.max(parsedRows, ROW_PAGE_STEP), ROW_PAGE_MAX)
    : ROW_PAGE_STEP;
  // `view` controls the per-board sub-sub-tab. Only meaningful when the
  // active dataset is a board key (the flat Dropdowns dataset ignores it).
  // Defaults to "rows" so the Data tab opens on the actual item data — a
  // tab called "Data" showing schema-first was confusing. Info / Dropdowns
  // stay one click away.
  const view: "info" | "dropdowns" | "rows" =
    viewParam === "info" || viewParam === "dropdowns" || viewParam === "rows"
      ? viewParam
      : "rows";
  const known = listKnownBoards();
  // Dataset selection. Defaults to the first known board's key.
  const dataset =
    datasetParam === "dropdowns" || known.some((b) => b.key === datasetParam)
      ? datasetParam!
      : known[0]?.key ?? "dropdowns";

  // Active board for board-level datasets. `boardKey` falls back to `dataset`
  // when the dataset itself is a board key.
  const boardKey =
    boardKeyParam && known.some((b) => b.key === boardKeyParam)
      ? boardKeyParam
      : dataset !== "dropdowns"
        ? dataset
        : null;

  // Resolve the Monday board id we'll filter on (if any).
  const boardId =
    boardKey && boardKey in MONDAY_BOARDS
      ? MONDAY_BOARDS[boardKey as keyof typeof MONDAY_BOARDS]
      : null;

  const ghostBoard = boardId
    ? await db.mondayGhostBoard.findUnique({
        where: { mondayBoardId: boardId },
        include: {
          columns: {
            orderBy: { createdAt: "asc" },
            include: {
              options: { orderBy: { label: "asc" } },
              _count: { select: { options: true } },
            },
          },
          _count: { select: { items: true } },
        },
      })
    : null;

  // Only pay for the items query when the user is on the data-rows view.
  // The Info / Dropdowns views don't render items so we skip the read.
  const items =
    ghostBoard && view === "rows"
      ? await db.mondayGhostItem.findMany({
          where: { boardId: ghostBoard.id },
          orderBy: { name: "asc" },
          take: rowLimit,
          select: {
            id: true,
            mondayItemId: true,
            name: true,
            groupTitle: true,
            columnValues: true,
            lastSyncedAt: true,
          },
        })
      : [];

  // For the "Dropdowns" sub-tab — flat list of every dropdown / status option
  // across every ghost board.
  const dropdownsView =
    dataset === "dropdowns"
      ? await db.mondayGhostDropdownOption.findMany({
          orderBy: [{ label: "asc" }],
          include: {
            boardColumn: {
              select: {
                id: true,
                title: true,
                mondayColumnId: true,
                type: true,
                board: { select: { mondayBoardId: true, name: true, label: true } },
              },
            },
          },
        })
      : [];

  return (
    <DataTab
      rowLimit={rowLimit}
      datasets={[
        ...known.map((b) => ({
          key: b.key,
          label: b.label,
          kind: "board" as const,
          mondayBoardId: b.id,
        })),
        { key: "dropdowns", label: "Dropdowns", kind: "flat" as const, mondayBoardId: null },
      ]}
      activeDataset={dataset}
      activeView={view}
      boardLabels={MONDAY_BOARD_LABELS}
      board={
        ghostBoard
          ? {
              id: ghostBoard.id,
              mondayBoardId: ghostBoard.mondayBoardId,
              name: ghostBoard.name,
              label: ghostBoard.label,
              description: ghostBoard.description,
              itemCount: ghostBoard.itemCount,
              lastSyncedAt: ghostBoard.lastSyncedAt,
              totalItems: ghostBoard._count.items,
              columns: ghostBoard.columns.map((c) => ({
                id: c.id,
                mondayColumnId: c.mondayColumnId,
                title: c.title,
                type: c.type,
                description: c.description,
                settings: c.settings,
                optionCount: c._count.options,
                options: c.options.map((o) => ({
                  id: o.id,
                  optionId: o.optionId,
                  label: o.label,
                  color: o.color,
                })),
              })),
            }
          : null
      }
      items={items.map((i) => ({
        id: i.id,
        mondayItemId: i.mondayItemId,
        name: i.name,
        groupTitle: i.groupTitle,
        columnValues: i.columnValues,
        lastSyncedAt: i.lastSyncedAt,
      }))}
      dropdowns={dropdownsView.map((o) => ({
        id: o.id,
        optionId: o.optionId,
        label: o.label,
        color: o.color,
        columnTitle: o.boardColumn.title,
        mondayColumnId: o.boardColumn.mondayColumnId,
        columnType: o.boardColumn.type,
        boardName: o.boardColumn.board.label ?? o.boardColumn.board.name,
        mondayBoardId: o.boardColumn.board.mondayBoardId,
      }))}
    />
  );
}

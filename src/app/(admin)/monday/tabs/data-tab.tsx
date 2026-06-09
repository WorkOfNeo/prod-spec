// Server component — the Data tab. Two-level navigation:
//
//   Sub-tab nav (top)        : pick a ghost database (board or "Dropdowns")
//   Sub-sub-tab nav (in body): per-board → Info | Dropdowns | Data rows
//
// Filter / pagination state stays in the URL via `dataset`, `boardKey`,
// `view` query params so picks survive page refreshes and are link-shareable.

import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { DropdownSearch, type SearchableOption } from "./dropdown-search";

type Dataset = {
  key: string;
  label: string;
  kind: "board" | "flat";
  mondayBoardId: string | null;
};

type BoardColumn = {
  id: string;
  mondayColumnId: string;
  title: string;
  type: string;
  description: string | null;
  settings: unknown;
  optionCount: number;
  options: Array<{ id: string; optionId: string; label: string; color: string | null }>;
};

type BoardData = {
  id: string;
  mondayBoardId: string;
  name: string;
  label: string | null;
  description: string | null;
  itemCount: number;
  lastSyncedAt: Date | null;
  totalItems: number;
  columns: BoardColumn[];
};

type ItemRow = {
  id: string;
  mondayItemId: string;
  name: string;
  groupTitle: string | null;
  columnValues: unknown;
  lastSyncedAt: Date;
};

type DropdownRow = {
  id: string;
  optionId: string;
  label: string;
  color: string | null;
  columnTitle: string;
  mondayColumnId: string;
  columnType: string;
  boardName: string;
  mondayBoardId: string;
};

type View = "info" | "dropdowns" | "rows";

const BOARD_VIEWS: Array<{ key: View; label: string }> = [
  { key: "info", label: "Info" },
  { key: "dropdowns", label: "Dropdowns" },
  { key: "rows", label: "Data rows" },
];

// Data-rows pagination. The Data rows view loads `rowLimit` items
// server-side; "Load more" bumps the `rows` URL param by ROW_PAGE_STEP up
// to ROW_PAGE_MAX (a ceiling so one page can't try to render an entire
// huge board's JSON at once).
export const ROW_PAGE_STEP = 200;
export const ROW_PAGE_MAX = 2000;

export function DataTab({
  datasets,
  activeDataset,
  activeView,
  board,
  items,
  dropdowns,
  rowLimit,
}: {
  datasets: Dataset[];
  activeDataset: string;
  activeView: View;
  // Reserved for future use — kept on the call-site signature so the server
  // component can decide later whether to render board chrome by label.
  boardLabels?: Record<string, string>;
  board: BoardData | null;
  items: ItemRow[];
  dropdowns: DropdownRow[];
  rowLimit: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      {/* Sub-tab nav — picks the dataset. */}
      <nav className="overflow-x-auto">
        <ul className="flex min-w-max gap-1 rounded-md bg-zinc-100 p-1">
          {datasets.map((d) => (
            <li key={d.key}>
              <Link
                href={`/monday?tab=data&dataset=${d.key}`}
                scroll={false}
                className={`inline-block rounded px-3 py-1.5 text-xs font-medium transition ${
                  activeDataset === d.key
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {d.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {activeDataset === "dropdowns" ? (
        <FlatDropdownsView rows={dropdowns} />
      ) : (
        <BoardView
          board={board}
          items={items}
          datasetKey={activeDataset}
          activeView={activeView}
          rowLimit={rowLimit}
        />
      )}
    </div>
  );
}

// =====================================================
// Board view — one Monday board's ghost data, split into Info /
// Dropdowns / Data rows sub-sub-tabs.
// =====================================================

function BoardView({
  board,
  items,
  datasetKey,
  activeView,
  rowLimit,
}: {
  board: BoardData | null;
  items: ItemRow[];
  datasetKey: string;
  activeView: View;
  rowLimit: number;
}) {
  if (!board) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
        <p>This board hasn&apos;t been sunk yet.</p>
        <p className="mt-1">
          Run a sink from the{" "}
          <Link href="/monday?tab=sync" className="underline">
            Sync tab
          </Link>{" "}
          to populate it.
        </p>
      </div>
    );
  }

  const dropdownColumns = board.columns.filter(
    (c) => c.type === "dropdown" || c.type === "status" || c.type === "color",
  );
  const otherColumns = board.columns.filter(
    (c) => !(c.type === "dropdown" || c.type === "status" || c.type === "color"),
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">
              {board.label ?? board.name}{" "}
              <span className="ml-1 font-mono text-xs font-normal text-zinc-500">
                {board.mondayBoardId}
              </span>
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              {board.totalItems} items · {board.columns.length} columns ·{" "}
              {dropdownColumns.length} dropdown/status cols · synced{" "}
              {formatDate(board.lastSyncedAt)}
            </p>
            {board.description && (
              <p className="mt-1 text-xs text-zinc-500">{board.description}</p>
            )}
          </div>
          <Link
            href={`/monday?tab=inspector&boardId=${board.mondayBoardId}`}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Open in inspector →
          </Link>
        </div>
      </section>

      {/* Sub-sub-tab nav — Info / Dropdowns / Data rows. */}
      <nav className="border-b border-zinc-200">
        <ul className="flex gap-1">
          {BOARD_VIEWS.map((v) => {
            const count =
              v.key === "info"
                ? otherColumns.length
                : v.key === "dropdowns"
                  ? dropdownColumns.length
                  : board.totalItems;
            return (
              <li key={v.key}>
                <Link
                  href={`/monday?tab=data&dataset=${datasetKey}&view=${v.key}`}
                  scroll={false}
                  className={`inline-block border-b-2 px-4 py-2 text-sm font-medium transition ${
                    activeView === v.key
                      ? "border-zinc-900 text-zinc-900"
                      : "border-transparent text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  {v.label}{" "}
                  <span className="ml-1 text-xs text-zinc-400 tabular-nums">{count}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {activeView === "info" && <InfoView otherColumns={otherColumns} board={board} />}
      {activeView === "dropdowns" && <BoardDropdownsView dropdownColumns={dropdownColumns} />}
      {activeView === "rows" && (
        <DataRowsView
          items={items}
          total={board.totalItems}
          datasetKey={datasetKey}
          limit={rowLimit}
        />
      )}

      <div className="text-right font-mono text-[10px] text-zinc-400">
        dataset={datasetKey} · view={activeView}
      </div>
    </div>
  );
}

// =====================================================
// Info view — board metadata + non-dropdown columns.
// =====================================================

function InfoView({
  otherColumns,
  board,
}: {
  otherColumns: BoardColumn[];
  board: BoardData;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-2 gap-4 rounded-lg border border-zinc-200 bg-white p-4 md:grid-cols-4">
        <Stat label="Items" value={board.totalItems} />
        <Stat label="Columns" value={board.columns.length} />
        <Stat
          label="Dropdown / status cols"
          value={board.columns.filter((c) => c.type === "dropdown" || c.type === "status" || c.type === "color").length}
        />
        <Stat
          label="Last synced"
          textValue={board.lastSyncedAt ? formatDate(board.lastSyncedAt) : "never"}
        />
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Other columns ({otherColumns.length})
        </header>
        {otherColumns.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">
            All columns on this board are dropdown / status types.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Column ID</th>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {otherColumns.map((c) => (
                <tr key={c.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-mono text-xs">{c.mondayColumnId}</td>
                  <td className="px-4 py-2">{c.title}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-600">{c.type}</td>
                  <td className="px-4 py-2 text-xs text-zinc-500">{c.description ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// =====================================================
// Board Dropdowns view — searchable list of options grouped by column.
// =====================================================

function BoardDropdownsView({ dropdownColumns }: { dropdownColumns: BoardColumn[] }) {
  if (dropdownColumns.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
        This board has no dropdown or status columns.
      </div>
    );
  }

  // Flatten every column's options into one list. Search runs across the
  // whole set; grouping by column happens inside DropdownSearch (groups
  // pull from `mondayColumnId` / `columnTitle`).
  const options: SearchableOption[] = dropdownColumns.flatMap((c) =>
    c.options.map((o) => ({
      id: o.id,
      optionId: o.optionId,
      label: o.label,
      color: o.color,
      columnTitle: c.title,
      mondayColumnId: c.mondayColumnId,
      columnType: c.type,
    })),
  );

  // No board name in chip groups — we're already inside the board.
  return (
    <DropdownSearch
      options={options}
      grouped={true}
      emptyMessage="No matches in this board's dropdowns."
    />
  );
}

// =====================================================
// Data rows view — items table (paged at 200 server-side).
// =====================================================

function DataRowsView({
  items,
  total,
  datasetKey,
  limit,
}: {
  items: ItemRow[];
  total: number;
  datasetKey: string;
  limit: number;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
        No items synced yet. Run a sink from the{" "}
        <Link href="/monday?tab=sync" className="underline">
          Sync tab
        </Link>
        .
      </div>
    );
  }

  // "Load more" bumps the row limit by one page, capped at ROW_PAGE_MAX so
  // a single render can't try to materialise an entire huge board.
  const hasMore = items.length < total && limit < ROW_PAGE_MAX;
  const nextLimit = Math.min(limit + ROW_PAGE_STEP, ROW_PAGE_MAX);
  const cappedOut = items.length < total && limit >= ROW_PAGE_MAX;

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <header className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Items{" "}
        <span className="ml-2 normal-case text-zinc-400">
          (showing {items.length} of {total})
        </span>
      </header>
      <div className="max-h-[70vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-zinc-500 shadow-[inset_0_-1px_0_rgb(244,244,245)]">
            <tr>
              <th className="px-4 py-2">Monday id</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Group</th>
              <th className="px-4 py-2">Column values</th>
              <th className="px-4 py-2">Synced</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-t border-zinc-100 align-top">
                <td className="px-4 py-2 font-mono text-xs">{i.mondayItemId}</td>
                <td className="px-4 py-2">{i.name}</td>
                <td className="px-4 py-2 text-xs text-zinc-500">{i.groupTitle ?? "—"}</td>
                <td className="px-4 py-2 text-xs">
                  <details>
                    <summary className="cursor-pointer text-zinc-600">view</summary>
                    <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-tight">
                      {JSON.stringify(i.columnValues, null, 2)}
                    </pre>
                  </details>
                </td>
                <td className="px-4 py-2 text-xs text-zinc-500">{formatDate(i.lastSyncedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(hasMore || cappedOut) && (
        <footer className="flex items-center justify-center gap-3 border-t border-zinc-100 bg-zinc-50 px-4 py-3">
          {hasMore ? (
            <Link
              href={`/monday?tab=data&dataset=${datasetKey}&view=rows&rows=${nextLimit}`}
              scroll={false}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Load more ({Math.min(ROW_PAGE_STEP, total - items.length)} more)
            </Link>
          ) : (
            <span className="text-xs text-zinc-400">
              Showing the first {ROW_PAGE_MAX} — refine in Monday to see the rest.
            </span>
          )}
        </footer>
      )}
    </section>
  );
}

// =====================================================
// Flat Dropdowns view — every dropdown option across every board,
// searchable and scrollable.
// =====================================================

function FlatDropdownsView({ rows }: { rows: DropdownRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
        <p>No dropdown / status options synced yet.</p>
        <p className="mt-1">
          Run a sink from the{" "}
          <Link href="/monday?tab=sync" className="underline">
            Sync tab
          </Link>{" "}
          to populate.
        </p>
      </div>
    );
  }

  const options: SearchableOption[] = rows.map((r) => ({
    id: r.id,
    optionId: r.optionId,
    label: r.label,
    color: r.color,
    columnTitle: r.columnTitle,
    mondayColumnId: r.mondayColumnId,
    columnType: r.columnType,
    boardName: r.boardName,
    mondayBoardId: r.mondayBoardId,
  }));

  return <DropdownSearch options={options} grouped={true} maxHeight="75vh" />;
}

function Stat({
  label,
  value,
  textValue,
}: {
  label: string;
  value?: number;
  textValue?: string;
}) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {textValue ?? value?.toLocaleString("en-GB") ?? "—"}
      </div>
    </div>
  );
}

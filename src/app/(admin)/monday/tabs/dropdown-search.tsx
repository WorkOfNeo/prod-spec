"use client";

import { useMemo, useState } from "react";

export type SearchableOption = {
  id: string;
  optionId: string;
  label: string;
  color: string | null;
  // Optional grouping metadata — used by the flat /monday Dropdowns
  // tab to render rows grouped by (board, column). The per-board
  // sub-sub-tab leaves these blank because the grouping happens upstream.
  columnTitle?: string;
  mondayColumnId?: string;
  columnType?: string;
  boardName?: string;
  mondayBoardId?: string;
};

// Reusable searchable + scrollable dropdown-option list. Used by both:
//   * the flat /monday > Data > Dropdowns view (with grouping enabled)
//   * each board's Data > Dropdowns sub-sub-tab (no grouping; chips only)
//
// Search is case-insensitive across label, optionId, columnTitle, and
// boardName so "wash30", "PL", "Pre Order", and "color" all narrow the
// list the way you'd expect.
export function DropdownSearch({
  options,
  grouped,
  emptyMessage,
  maxHeight = "70vh",
}: {
  options: SearchableOption[];
  // When grouped=true we cluster by (board, column). When false we render
  // a single flat list — used inside a board view where we already know
  // the board, but might have many columns mixed in.
  grouped: boolean;
  emptyMessage?: string;
  // Caps the scroll container — defaults to 70vh which fills most laptops
  // without pushing the search bar off-screen.
  maxHeight?: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      return (
        o.label.toLowerCase().includes(q) ||
        o.optionId.includes(q) ||
        (o.columnTitle?.toLowerCase().includes(q) ?? false) ||
        (o.mondayColumnId?.toLowerCase().includes(q) ?? false) ||
        (o.boardName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [options, query]);

  // Build groups lazily so unfiltered renders are cheap.
  const groups = useMemo(() => {
    if (!grouped) return null;
    const m = new Map<
      string,
      { board: string; column: string; rows: SearchableOption[] }
    >();
    for (const r of filtered) {
      const key = `${r.mondayBoardId ?? ""}::${r.mondayColumnId ?? ""}`;
      let g = m.get(key);
      if (!g) {
        g = {
          board: r.boardName ? `${r.boardName} (${r.mondayBoardId ?? "—"})` : "",
          column: `${r.columnTitle ?? "—"} · ${r.columnType ?? "—"} · ${r.mondayColumnId ?? "—"}`,
          rows: [],
        };
        m.set(key, g);
      }
      g.rows.push(r);
    }
    return Array.from(m.values());
  }, [filtered, grouped]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search labels, columns, boards…"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
        />
        <span className="text-xs tabular-nums text-zinc-500">
          {filtered.length} / {options.length}
        </span>
      </div>

      <div
        className="overflow-y-auto rounded-lg border border-zinc-200 bg-white"
        style={{ maxHeight }}
      >
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">
            {emptyMessage ?? "No matches."}
          </p>
        ) : grouped && groups ? (
          <div className="divide-y divide-zinc-100">
            {groups.map((g) => (
              <section key={`${g.board}::${g.column}`} className="">
                <header className="sticky top-0 z-10 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs">
                  <div className="font-medium text-zinc-700">{g.column}</div>
                  {g.board && <div className="text-zinc-500">{g.board}</div>}
                </header>
                <ul className="flex flex-wrap gap-1.5 p-3">
                  {g.rows.map((o) => (
                    <OptionChip key={o.id} o={o} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="flex flex-wrap gap-1.5 p-3">
            {filtered.map((o) => (
              <OptionChip key={o.id} o={o} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OptionChip({ o }: { o: SearchableOption }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs">
      {o.color && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: o.color }}
        />
      )}
      <span>{o.label}</span>
      <span className="font-mono text-[10px] text-zinc-500">{o.optionId}</span>
    </li>
  );
}

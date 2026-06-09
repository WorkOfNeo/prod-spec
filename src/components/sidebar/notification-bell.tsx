"use client";

// Sidebar notification bell. Icon-only — sits next to the "Prod Spec"
// logo at the top of the sidebar. Polls /api/admin/import/counts every
// 60s for the badge number. Clicking opens a popover with the actual
// notification list (lazy-loaded from /api/admin/import/notifications
// so the cheap 60s poll stays small).
//
// Popover rows are plain links into /import. The bell is "first click
// shows the list" — actions still live on the full dashboard page.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Counts = {
  badge: number;
  parts: {
    combinations: number;
    importable: number;
    ambiguous: number;
    needsConfig: number;
  };
};

type NotificationRow =
  | {
      kind: "new_combination";
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      matchCount: number;
      ambiguousCount: number;
    }
  | {
      kind: "ready_to_import";
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      count: number;
    }
  | {
      kind: "needs_config";
      prodSpecId: string;
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      styleCount: number;
    };

type NotificationsBody = {
  notifications: NotificationRow[];
  totals: {
    newCombinations: number;
    importable: number;
    ambiguous: number;
    needsConfig: number;
  };
};

const POLL_MS = 60_000;

export function NotificationBell() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<NotificationsBody | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // ---------- Poll badge count ----------
  useEffect(() => {
    let cancelled = false;
    async function fetchCounts() {
      try {
        const res = await fetch("/api/admin/import/counts", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Counts;
        if (!cancelled) setCounts(body);
      } catch {
        // Silent — bell stays in last-known state.
      }
    }
    fetchCounts();
    const id = setInterval(fetchCounts, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---------- Click-outside + Escape to close ----------
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ---------- Lazy-load list on first open + refresh whenever opened ----------
  async function loadList() {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/admin/import/notifications", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setListError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as NotificationsBody;
      setList(body);
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setListLoading(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) loadList();
  }

  const badge = counts?.badge ?? 0;
  const ariaLabel = `Inbox: ${badge} item${badge === 1 ? "" : "s"}`;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {badge > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white tabular-nums">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute left-full top-0 z-50 ml-2 w-[340px] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Notifications
            </span>
            <Link
              href="/import"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:underline"
            >
              View all →
            </Link>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {listLoading && (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">Loading…</div>
            )}
            {!listLoading && listError && (
              <div className="px-3 py-4 text-sm text-red-700">{listError}</div>
            )}
            {!listLoading && !listError && list && list.notifications.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">All caught up.</div>
            )}
            {!listLoading && !listError && list && list.notifications.length > 0 && (
              <ul className="divide-y divide-zinc-100">
                {list.notifications.map((n) => (
                  <NotificationItem
                    key={`${n.kind}:${n.customerId}:${n.businessAreaId}`}
                    row={n}
                    onClick={() => setOpen(false)}
                  />
                ))}
              </ul>
            )}
          </div>

          {list && list.notifications.length > 0 && (
            <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-500">
              {list.totals.newCombinations} new ·{" "}
              {list.totals.needsConfig} needs config ·{" "}
              {list.totals.importable} ready
              {list.totals.ambiguous > 0 && ` · ${list.totals.ambiguous} ambiguous`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationItem({
  row,
  onClick,
}: {
  row: NotificationRow;
  onClick: () => void;
}) {
  if (row.kind === "new_combination") {
    return (
      <li>
        <Link
          href="/import"
          onClick={onClick}
          className="flex items-start gap-3 px-3 py-2.5 hover:bg-zinc-50"
        >
          <span className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-zinc-900">
              {row.customerName} · {row.businessAreaName}
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              New combination · {row.matchCount} match
              {row.matchCount === 1 ? "" : "es"}
              {row.ambiguousCount > 0 && ` (+${row.ambiguousCount} ambiguous)`}
            </span>
          </span>
        </Link>
      </li>
    );
  }
  if (row.kind === "needs_config") {
    return (
      <li>
        <Link
          href={`/prod-specs/${row.prodSpecId}`}
          onClick={onClick}
          className="flex items-start gap-3 px-3 py-2.5 hover:bg-zinc-50"
        >
          <span className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-blue-500" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-zinc-900">
              {row.customerName} · {row.businessAreaName}
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Needs config · {row.styleCount} style
              {row.styleCount === 1 ? "" : "s"} waiting · no outputs set
            </span>
          </span>
        </Link>
      </li>
    );
  }
  return (
    <li>
      <Link
        href="/import"
        onClick={onClick}
        className="flex items-start gap-3 px-3 py-2.5 hover:bg-zinc-50"
      >
        <span className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-zinc-900">
            {row.customerName} · {row.businessAreaName}
          </span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            Ready to import · {row.count} item{row.count === 1 ? "" : "s"}
          </span>
        </span>
      </Link>
    </li>
  );
}

"use client";

// Sidebar "My tasks" link with the waiting-on-you badge. Polls
// /api/admin/dashboard/counts every 60s — same rhythm as the import
// notification bell. Badge counts your unfinished reviews + the untouched
// first-review queue; reviews other users have in flight are excluded.

import Link from "next/link";
import { useEffect, useState } from "react";

type Counts = {
  badge: number;
  parts: { mine: number; queue: number; others: number };
};

const POLL_MS = 60_000;

export function MyTasksLink() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchCounts() {
      try {
        const res = await fetch("/api/admin/dashboard/counts", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Counts;
        if (!cancelled) setCounts(body);
      } catch {
        // Silent — the badge stays in its last-known state.
      }
    }
    fetchCounts();
    const id = setInterval(fetchCounts, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const badge = counts?.badge ?? 0;

  return (
    <Link
      href="/dashboard"
      className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
    >
      <span>My tasks</span>
      {badge > 0 && (
        <span
          className="inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-4 text-white tabular-nums"
          title={`${counts!.parts.mine} unfinished · ${counts!.parts.queue} waiting for first review`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

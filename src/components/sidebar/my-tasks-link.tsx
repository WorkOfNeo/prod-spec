"use client";

// Sidebar "My tasks" link with the waiting-on-you badge. Polls
// /api/admin/dashboard/counts every 60s while the tab is visible — same
// rhythm as the import notification bell (scheduling: useVisiblePoll). Badge
// counts only reviews YOU'VE STARTED and haven't finished; the untouched
// first-review queue and others' in-flight reviews are excluded (the full
// queue lives on /reviews).

import Link from "next/link";
import { useState } from "react";
import { useVisiblePoll } from "@/lib/use-visible-poll";

type Counts = {
  badge: number;
  parts: { mine: number; queue: number; others: number };
};

const POLL_MS = 60_000;

export function MyTasksLink() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useVisiblePoll(async (signal) => {
    try {
      const res = await fetch("/api/admin/dashboard/counts", { cache: "no-store", signal });
      if (!res.ok) return;
      setCounts((await res.json()) as Counts);
    } catch {
      // Silent — the badge stays in its last-known state (or unmounted).
    }
  }, POLL_MS);

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
          title={`${counts!.parts.mine} review${counts!.parts.mine === 1 ? "" : "s"} you've started and haven't finished`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

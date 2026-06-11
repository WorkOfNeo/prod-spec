"use client";

// The dashboard's notification feed — event-shaped, per-user rows
// (UserNotification), distinct from the derived review sections above it.
// Rows come pre-shaped from the server page; actions POST and refresh so
// the server stays the single source of truth.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type FeedRow = {
  id: string;
  type: "REVIEW_READY" | "TICKET_FIXED" | "GENERIC";
  title: string;
  body: string | null;
  href: string | null;
  createdAgo: string;
  unread: boolean;
};

const DOT: Record<FeedRow["type"], string> = {
  REVIEW_READY: "bg-blue-500",
  TICKET_FIXED: "bg-violet-500",
  GENERIC: "bg-zinc-400",
};

export function NotificationsFeed({ rows }: { rows: FeedRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function dismiss(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/admin/notifications/${id}/dismiss`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function readAll() {
    setBusy("read-all");
    try {
      await fetch("/api/admin/notifications/read-all", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const unreadCount = rows.filter((r) => r.unread).length;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-800">Notifications</h2>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={readAll}
            disabled={busy !== null}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-900 hover:underline disabled:opacity-50"
          >
            Mark all read
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">
          Nothing here — review-ready and fixed-rejection notices land in this feed.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100">
          {rows.map((n) => (
            <li key={n.id} className="flex items-start gap-3 py-2.5">
              <span
                className={`mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${DOT[n.type]} ${n.unread ? "" : "opacity-30"}`}
              />
              <div className="min-w-0 flex-1">
                {n.href ? (
                  <Link
                    href={n.href}
                    className={`block text-sm hover:underline ${n.unread ? "font-semibold text-zinc-900" : "text-zinc-600"}`}
                  >
                    {n.title}
                  </Link>
                ) : (
                  <span
                    className={`block text-sm ${n.unread ? "font-semibold text-zinc-900" : "text-zinc-600"}`}
                  >
                    {n.title}
                  </span>
                )}
                <span className="mt-0.5 block text-xs text-zinc-500">
                  {n.body ? <>{n.body} · </> : null}
                  {n.createdAgo}
                </span>
              </div>
              <button
                type="button"
                onClick={() => dismiss(n.id)}
                disabled={busy !== null}
                aria-label="Dismiss notification"
                title="Dismiss"
                className="rounded-md px-1.5 text-sm leading-6 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

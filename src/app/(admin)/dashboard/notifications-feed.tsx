"use client";

// The dashboard's notification feed — event-shaped, per-user rows
// (UserNotification), distinct from the derived review sections beside it.
// Rows come pre-shaped from the server page; actions POST and refresh so
// the server stays the single source of truth.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot, type PillTone } from "@/components/ui/pill";

export type FeedRow = {
  id: string;
  type: "REVIEW_READY" | "TICKET_FIXED" | "GENERIC";
  title: string;
  body: string | null;
  href: string | null;
  createdAgo: string;
  unread: boolean;
};

const TONE: Record<FeedRow["type"], PillTone> = {
  REVIEW_READY: "accent",
  TICKET_FIXED: "good",
  GENERIC: "neutral",
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
    <section data-section="Notifications" className="border-line bg-surface overflow-hidden rounded-xl border">
      <div className="border-line flex items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-ink text-[14px] font-semibold">Notifications</h2>
          <p className="text-muted text-[12px]">What happened to your work</p>
        </div>
        {unreadCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={readAll} disabled={busy !== null}>
            Mark all read
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="text-muted px-4 py-4 text-[12px]">
          Nothing here. Reviews ready for you and fixed comments land in this feed.
        </p>
      ) : (
        <ul className="divide-line divide-y">
          {rows.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-4 py-2.5">
              <StatusDot tone={TONE[n.type]} className={`mt-[7px] ${n.unread ? "" : "opacity-30"}`} />
              <div className="min-w-0 flex-1">
                {n.href ? (
                  <Link
                    href={n.href}
                    className={`block text-[13px] hover:underline ${n.unread ? "text-ink font-medium" : "text-muted"}`}
                  >
                    {n.title}
                  </Link>
                ) : (
                  <span className={`block text-[13px] ${n.unread ? "text-ink font-medium" : "text-muted"}`}>{n.title}</span>
                )}
                <span className="text-muted mt-0.5 block text-[12px]">
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
                className="text-faint hover:bg-subtle hover:text-ink inline-flex size-6 shrink-0 items-center justify-center rounded-md disabled:opacity-50"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

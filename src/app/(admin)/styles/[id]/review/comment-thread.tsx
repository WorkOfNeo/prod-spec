"use client";

import { ChevronRight, ImageIcon } from "lucide-react";
import { Pill, type PillTone } from "@/components/ui/pill";
import { UserAvatar } from "@/components/user-avatar";
import { timeAgo } from "@/lib/time";
import type { ThreadView, TicketStatus } from "./review-types";

// The comments on one output, as the rejection log holds them: the reviewer's
// first comment, anything added since, and where the fix stands. Earlier,
// resolved threads fold away underneath.

const TICKET: Record<TicketStatus, { tone: PillTone; label: string }> = {
  OPEN: { tone: "warn", label: "Waiting for a fix" },
  IN_PROGRESS: { tone: "accent", label: "Being fixed" },
  FIXED: { tone: "good", label: "Fixed, check again" },
  RESOLVED: { tone: "neutral", label: "Resolved" },
};

function Thread({ thread, compact = false }: { thread: ThreadView; compact?: boolean }) {
  return (
    <ol className="flex flex-col gap-2">
      {thread.entries.map((entry, i) => (
        <li key={i} className={`border-line bg-surface rounded-lg border ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
          <div className="text-muted flex items-center gap-1.5 text-[12px]">
            {i === 0 ? (
              <>
                <UserAvatar name={thread.reporter} size="xs" />
                <span data-private className="text-ink font-medium">
                  {thread.reporter}
                </span>
                <span suppressHydrationWarning>· {timeAgo(new Date(thread.createdAtIso))}</span>
              </>
            ) : (
              <span>Added {entry.stamp}</span>
            )}
          </div>
          <p className="text-ink mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{entry.text}</p>
        </li>
      ))}
      {thread.attachmentCount > 0 ? (
        <li>
          {thread.attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {thread.attachments.map((a) => (
                <a
                  key={a.id}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={a.fileName}
                  className="border-line bg-subtle block size-14 overflow-hidden rounded-md border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- served from the admin attachment route */}
                  <img src={a.url} alt={a.fileName} className="size-full object-cover" />
                </a>
              ))}
            </div>
          ) : (
            <span className="text-muted inline-flex items-center gap-1 text-[12px]">
              <ImageIcon size={13} aria-hidden="true" />
              {thread.attachmentCount} image{thread.attachmentCount === 1 ? "" : "s"} attached
            </span>
          )}
        </li>
      ) : null}
    </ol>
  );
}

export function CommentThread({ thread, pastThreads }: { thread: ThreadView | null; pastThreads: ThreadView[] }) {
  if (!thread && pastThreads.length === 0) return null;
  return (
    <section data-section="Comments" className="flex flex-col gap-2">
      {thread ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ink text-[12px] font-medium">Comments</h3>
            <Pill tone={TICKET[thread.status].tone} dot>
              {TICKET[thread.status].label}
            </Pill>
          </div>
          <Thread thread={thread} />
        </>
      ) : null}
      {pastThreads.length > 0 ? (
        <details className="group">
          <summary className="text-muted hover:text-ink flex cursor-pointer list-none items-center gap-1 text-[12px] [&::-webkit-details-marker]:hidden">
            <ChevronRight size={13} aria-hidden="true" className="transition-transform group-open:rotate-90" />
            {pastThreads.length} earlier thread{pastThreads.length === 1 ? "" : "s"}, resolved
          </summary>
          <div className="mt-2 flex flex-col gap-3 opacity-80">
            {pastThreads.map((t) => (
              <Thread key={t.ticketId} thread={t} compact />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

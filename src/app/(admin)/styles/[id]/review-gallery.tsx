"use client";

import Link from "next/link";
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { Pill, type PillTone } from "@/components/ui/pill";
import { UserAvatar } from "@/components/user-avatar";

// The style's Review tab: every current output as a thumbnail, filterable by
// where it stands. Looking happens here; deciding happens on the review screen
// ("Review & decide", or a card, which opens that output there).

export type GalleryItem = {
  key: string;
  anchor: string;
  thumbSrc: string;
  typeLabel: string;
  name: string;
  fileName: string;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  // The open comment thread's state, when there is one.
  ticket: "OPEN" | "IN_PROGRESS" | "FIXED" | null;
  blocked: boolean;
  reviewer: string | null;
  dateLabel: string | null;
  comments: number;
};

type Filter = "all" | "pending" | "approved" | "rejected";

const STATUS: Record<GalleryItem["status"], { tone: PillTone; label: string }> = {
  APPROVED: { tone: "good", label: "Approved" },
  REJECTED: { tone: "bad", label: "Changes requested" },
  PENDING_REVIEW: { tone: "neutral", label: "To review" },
};

function matches(item: GalleryItem, f: Filter) {
  if (f === "all") return true;
  if (f === "approved") return item.status === "APPROVED";
  if (f === "rejected") return item.status === "REJECTED";
  return item.status === "PENDING_REVIEW";
}

export function ReviewGallery({
  styleId,
  items,
  owner,
  summary,
}: {
  styleId: string;
  items: GalleryItem[];
  // Who owns the review in progress (claimed it, or decided first).
  owner: { name: string; since: string | null } | null;
  summary: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts: Record<Filter, number> = {
    all: items.length,
    pending: items.filter((i) => matches(i, "pending")).length,
    approved: items.filter((i) => matches(i, "approved")).length,
    rejected: items.filter((i) => matches(i, "rejected")).length,
  };
  const shown = items.filter((i) => matches(i, filter));
  const segments: Array<[Filter, string]> = [
    ["all", "All"],
    ["pending", "Pending"],
    ["approved", "Approved"],
    ["rejected", "Changes requested"],
  ];

  return (
    <section data-section="Review gallery" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Show" className="bg-seg inline-flex rounded-lg p-0.5">
          {segments.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors duration-150 ${
                filter === key ? "bg-seg-on text-seg-on-ink font-medium shadow-[var(--shadow-pop)]" : "text-muted hover:text-ink"
              }`}
            >
              {label}
              <span className="text-faint tabular-nums">{counts[key]}</span>
            </button>
          ))}
        </div>
        <span className="text-muted inline-flex items-center gap-1.5 text-[12px]">
          {owner ? (
            <>
              <UserAvatar name={owner.name} size="xs" />
              <span data-private>
                In review by <span className="text-ink">{owner.name}</span>
                {owner.since ? ` · since ${owner.since}` : ""}
              </span>
            </>
          ) : (
            "Nobody owns this review yet"
          )}
        </span>
        <span className="flex-1" />
        <Link href={`/styles/${styleId}/review`} className={buttonClass("primary")}>
          Review &amp; decide
        </Link>
      </div>
      <p className="text-muted text-[12px]">{summary}</p>

      {shown.length === 0 ? (
        <p className="border-line text-muted rounded-xl border border-dashed px-4 py-10 text-center text-[13px]">
          {items.length === 0 ? "Nothing generated yet. Re-run to generate the outputs." : "Nothing in this group."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {shown.map((it) => {
            const st = STATUS[it.status];
            return (
              <li key={it.key}>
                <Link
                  href={`/styles/${styleId}/review#${it.anchor}`}
                  className="border-line bg-surface hover:border-faint group block overflow-hidden rounded-xl border transition-colors duration-150"
                >
                  {/* Print proofs are always on paper, whatever the theme. */}
                  <div className="border-line bg-canvas flex h-44 items-center justify-center border-b p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element -- server-rendered PNG of page 1, cached per asset version */}
                    <img
                      src={it.thumbSrc}
                      alt=""
                      loading="lazy"
                      className="max-h-full max-w-full bg-white object-contain shadow-[var(--shadow-pop)]"
                    />
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="text-muted text-[11px]">{it.typeLabel}</div>
                    <div className="text-ink truncate text-[13px] font-medium" title={it.name}>
                      {it.name}
                    </div>
                    <div className="text-muted truncate font-mono text-[11px]" title={it.fileName}>
                      {it.fileName}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Pill tone={st.tone} dot>
                        {st.label}
                      </Pill>
                      {it.ticket === "FIXED" ? <Pill tone="accent">Fixed, check again</Pill> : null}
                      {it.blocked && it.status === "PENDING_REVIEW" ? <Pill tone="warn">Blocked</Pill> : null}
                    </div>
                    <div className="text-muted mt-1.5 flex items-center gap-2 text-[11px]">
                      <span className="min-w-0 flex-1 truncate" data-private>
                        {it.reviewer ? `${it.reviewer} · ${it.dateLabel ?? ""}` : it.dateLabel ?? ""}
                      </span>
                      {it.comments > 0 ? (
                        <span className="inline-flex items-center gap-0.5 tabular-nums" title={`${it.comments} comment${it.comments === 1 ? "" : "s"}`}>
                          <MessageSquare size={11} aria-hidden="true" />
                          {it.comments}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, MessageSquare, Wrench } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { Pill, StatusDot } from "@/components/ui/pill";
import { CommentThread } from "./comment-thread";
import { DecisionPanel } from "./decision-panel";
import type { ProofItem, ReviewItem } from "./review-types";

// The review loop: every output down the left, the selected proof in the
// middle, and on the right what's been said about it and the decision. A
// decision moves you on to the next output still waiting, so a style is
// reviewed top to bottom without hunting for the next card.
//
// Selection is local (no round trip) and mirrored into the #fragment, the
// same output-… anchors other pages already deep-link to.

function firstWaiting(items: ReviewItem[]): ReviewItem | undefined {
  return items.find((i) => i.kind === "proof" && i.status === "PENDING_REVIEW") ?? items.find((i) => i.kind === "proof") ?? items[0];
}

function commentCount(item: ReviewItem): number {
  return item.kind === "proof" ? (item.thread?.entries.length ?? 0) : 0;
}

export function ReviewWorkspace({
  styleId,
  styleContext,
  canPush,
  items,
  panels,
  tools,
  collapsedGroups,
  progress,
}: {
  styleId: string;
  styleContext: string;
  canPush: boolean;
  items: ReviewItem[];
  // Rendered on the server, keyed by item key: the centre panel for a
  // non-proof item, and the per-output tools under a proof's decision.
  panels: Record<string, ReactNode>;
  tools: Record<string, ReactNode>;
  // List sections that start folded (earlier generations, excluded).
  collapsedGroups: string[];
  progress: { decided: number; total: number };
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(() => firstWaiting(items)?.key ?? null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set(collapsedGroups));
  const proofRef = useRef<HTMLElement>(null);

  // A deep link (#output-…) picks its output once the page is in the browser.
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    const hit = anchor ? items.find((i) => i.anchor === anchor) : undefined;
    if (hit) select(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a refresh the selected output may have moved section or gone.
  const selected = items.find((i) => i.key === selectedKey) ?? firstWaiting(items) ?? null;

  const groups = useMemo(() => {
    const map = new Map<string, ReviewItem[]>();
    for (const item of items) {
      const list = map.get(item.group);
      if (list) list.push(item);
      else map.set(item.group, [item]);
    }
    return [...map.entries()].map(([label, list]) => ({ label, items: list }));
  }, [items]);

  const proofs = useMemo(() => items.filter((i): i is ProofItem => i.kind === "proof"), [items]);
  const proofIndex = selected?.kind === "proof" ? proofs.findIndex((p) => p.key === selected.key) : -1;

  function select(item: ReviewItem, reveal = false) {
    setSelectedKey(item.key);
    setFolded((prev) => {
      if (!prev.has(item.group)) return prev;
      const next = new Set(prev);
      next.delete(item.group);
      return next;
    });
    try {
      window.history.replaceState(window.history.state, "", `#${item.anchor}`);
    } catch {
      // Some embedded browsers refuse; the selection still works.
    }
    // Stacked (narrow) layout: the proof is below the list, so bring it up.
    if (reveal && window.matchMedia("(max-width: 1023px)").matches) {
      proofRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function step(delta: number) {
    if (proofs.length === 0) return;
    const from = proofIndex < 0 ? 0 : proofIndex;
    select(proofs[(from + delta + proofs.length) % proofs.length]);
  }

  // The next output still waiting after this one, wrapping round; stay put
  // when it was the last.
  function advanceFrom(key: string) {
    const at = proofs.findIndex((p) => p.key === key);
    for (let n = 1; n < proofs.length; n++) {
      const p = proofs[(at + n) % proofs.length];
      if (p.status === "PENDING_REVIEW") {
        select(p);
        return;
      }
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.decided / progress.total) * 100) : 0;

  return (
    <div
      data-section="Review workspace"
      className="border-line grid grid-cols-1 border-t lg:grid-cols-[264px_minmax(0,1fr)] xl:min-h-0 xl:flex-1 xl:grid-cols-[264px_minmax(0,1fr)_344px] xl:grid-rows-[minmax(0,1fr)]"
    >
      {/* The list. */}
      <nav
        aria-label="Outputs"
        className="border-line bg-sidebar border-b lg:sticky lg:top-12 lg:row-span-2 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:border-r lg:border-b-0 xl:static xl:row-span-1 xl:max-h-none"
      >
        <div className="border-line bg-sidebar sticky top-12 z-10 border-b px-3 py-3 lg:top-0">
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="text-ink font-medium">Outputs</span>
            <span className="text-muted tabular-nums">
              {progress.decided} of {progress.total} decided
            </span>
          </div>
          <div className="bg-subtle mt-2 h-1 overflow-hidden rounded-full">
            <span className="bg-good block h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="flex flex-col gap-3 px-2 py-3">
          {groups.map((group) => {
            const isFolded = folded.has(group.label);
            return (
              <div key={group.label}>
                <button
                  type="button"
                  onClick={() =>
                    setFolded((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.label)) next.delete(group.label);
                      else next.add(group.label);
                      return next;
                    })
                  }
                  aria-expanded={!isFolded}
                  className="text-faint hover:text-muted flex w-full items-center gap-1 px-2 pb-1 text-left text-[12px] font-medium"
                >
                  <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${isFolded ? "-rotate-90" : ""}`} />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <span className="tabular-nums">{group.items.length}</span>
                </button>
                {isFolded ? null : (
                  <ul className="flex flex-col gap-px">
                    {group.items.map((item) => {
                      const active = selected?.key === item.key;
                      const comments = commentCount(item);
                      return (
                        <li key={item.key}>
                          <button
                            type="button"
                            onClick={() => select(item, true)}
                            aria-current={active ? "true" : undefined}
                            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
                              active ? "bg-active" : "hover:bg-subtle"
                            }`}
                          >
                            <StatusDot tone={item.tone} className="mt-[5px]" />
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate text-[13px] ${active ? "text-active-ink font-medium" : "text-ink"}`} title={item.name}>
                                {item.name}
                              </span>
                              {item.statusLabel ? (
                                <span className="text-muted block truncate text-[11px]">{item.statusLabel}</span>
                              ) : null}
                            </span>
                            {comments > 0 ? (
                              <span
                                className="text-muted mt-0.5 inline-flex items-center gap-0.5 text-[11px] tabular-nums"
                                title={`${comments} comment${comments === 1 ? "" : "s"}`}
                              >
                                <MessageSquare size={11} aria-hidden="true" />
                                {comments}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* The proof (or the panel for a non-proof item). */}
      <section ref={proofRef} aria-label="Proof" className="bg-canvas flex min-w-0 scroll-mt-12 flex-col xl:min-h-0">
        {selected ? (
          <>
            <div className="border-line bg-surface flex h-11 shrink-0 items-center gap-2 border-b px-3">
              {selected.kind === "proof" ? (
                <>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => step(-1)}
                      aria-label="Previous output"
                      className="text-muted hover:bg-subtle hover:text-ink inline-flex size-7 items-center justify-center rounded-md"
                    >
                      <ChevronLeft size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => step(1)}
                      aria-label="Next output"
                      className="text-muted hover:bg-subtle hover:text-ink inline-flex size-7 items-center justify-center rounded-md"
                    >
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <span className="text-muted shrink-0 text-[12px] tabular-nums">
                    {proofIndex + 1} of {proofs.length}
                  </span>
                  <span aria-hidden="true" className="bg-line h-4 w-px shrink-0" />
                </>
              ) : null}
              <span className="text-ink max-w-[55%] min-w-0 shrink-0 truncate text-[13px] font-medium" title={selected.name}>
                {selected.name}
              </span>
              {selected.kind === "proof" && selected.fileName ? (
                <span className="text-muted hidden min-w-0 truncate font-mono text-[11px] md:inline" title={selected.fileName}>
                  {selected.fileName}
                </span>
              ) : null}
              {selected.kind === "proof"
                ? selected.chips.map((c) => (
                    <Pill key={c} tone="neutral" className="hidden sm:inline-flex">
                      {c}
                    </Pill>
                  ))
                : null}
              <span className="flex-1" />
              {selected.kind === "proof" ? (
                <a
                  href={selected.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass("ghost", "sm", "shrink-0")}
                  title="Open the full PDF in a new tab"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  Open PDF
                </a>
              ) : null}
            </div>
            {selected.kind === "proof" ? (
              <>
                {selected.placeholderCount > 0 ? (
                  <div className="border-line bg-warn-soft text-warn shrink-0 border-b px-3 py-2 text-[12px]">
                    {selected.placeholderCount} placeholder{selected.placeholderCount === 1 ? "" : "s"} in this PDF.
                    Approval is blocked until the data is fixed and the output re-run.
                  </div>
                ) : null}
                <div className="h-[75vh] min-h-0 xl:h-auto xl:flex-1">
                  <iframe key={selected.previewUrl} src={selected.previewUrl} className="block size-full bg-white" title={selected.name} />
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <div className="reveal max-w-2xl">{panels[selected.key]}</div>
              </div>
            )}
          </>
        ) : (
          <p className="text-muted p-6 text-[13px]">Nothing to show yet.</p>
        )}
      </section>

      {/* What's been said, and the decision. */}
      <aside
        aria-label="Decision"
        className="border-line bg-bg border-t lg:col-start-2 xl:col-start-3 xl:row-start-1 xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-l"
      >
        {selected?.kind === "proof" ? (
          <div key={selected.key} className="reveal flex flex-col gap-5 p-4">
            <div className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-ink text-[14px] leading-5 font-semibold">{selected.name}</h2>
                {selected.status !== "APPROVED" ? (
                  <Pill tone={selected.tone} dot>
                    {selected.statusLabel}
                  </Pill>
                ) : null}
              </div>
              {selected.fileName ? (
                <p className="text-muted mt-1 truncate font-mono text-[11px]" title={selected.fileName}>
                  {selected.fileName}
                </p>
              ) : null}
            </div>

            <CommentThread thread={selected.thread} pastThreads={selected.pastThreads} />

            <DecisionPanel
              key={`${selected.key}:${selected.status}`}
              item={selected}
              styleId={styleId}
              styleContext={styleContext}
              canPush={canPush}
              onDecided={() => advanceFrom(selected.key)}
            />

            {tools[selected.key] ? (
              <details className="group border-line border-t pt-4">
                <summary className="text-muted hover:text-ink flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium [&::-webkit-details-marker]:hidden">
                  <Wrench size={13} aria-hidden="true" />
                  <span className="flex-1">Change it yourself</span>
                  <ChevronRight size={13} aria-hidden="true" className="transition-transform group-open:rotate-90" />
                </summary>
                <div className="mt-3 flex flex-col gap-3">{tools[selected.key]}</div>
              </details>
            ) : null}
          </div>
        ) : selected ? (
          <div key={selected.key} className="reveal flex flex-col gap-2 p-4">
            <h2 className="text-ink text-[14px] font-semibold">{selected.name}</h2>
            {selected.statusLabel ? (
              <div>
                <Pill tone={selected.tone} dot>
                  {selected.statusLabel}
                </Pill>
              </div>
            ) : null}
            <p className="text-muted text-[12px]">Nothing to decide here.</p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

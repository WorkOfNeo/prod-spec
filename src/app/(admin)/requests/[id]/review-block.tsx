"use client";

import { useEffect, useState } from "react";
import { Bot, FileDiff, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ImpactCounts, ImpactSummary } from "@/lib/change-requests/types";
import type { MessageView, OutputView, RevisionView } from "@/lib/change-requests/review-view";
import { ApproveBar, type ApproveResult } from "./approve-bar";
import { ImpactTable } from "./impact-table";
import { ProofCard, type ProofPick } from "./proof-card";
import { errorOf, getJson, latest } from "./shared";

// The review of one output's drafts (ADMIN): pick a draft (newest first, the
// current one by default), look at its before/after proofs, read what the
// agent says it did, see exactly which documents change and what changed in
// the layout definition, then approve or reject the CURRENT draft.
//
// Proofs + impact and the diff are fetched per draft and kept for the visit,
// so flicking between drafts doesn't refetch. The current draft's stored
// impact is shown at once while its proofs load.

type ProofsResponse = { picks: ProofPick[]; impactCounts: ImpactCounts; impact: ImpactSummary };
type LayoutChange = { kind: string; page: number; blockId?: string; summary: string };
type DiffResponse = { changes: LayoutChange[]; before: unknown; after: unknown };

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

// Fetch once per URL and remember the answer for the life of the component.
// Not in the map yet = loading; an aborted fetch (the draft was switched
// away from) stores nothing, so coming back fetches again.
function useCachedFetch<T>(url: string | null): Load<T> | null {
  const [results, setResults] = useState<Record<string, Load<T>>>({});
  const known = url !== null && url in results;
  useEffect(() => {
    if (!url || known) return;
    const controller = new AbortController();
    getJson<T>(url, controller.signal)
      .then((res) => {
        const load: Load<T> = res.ok ? { state: "ready", data: res.data } : { state: "error", message: errorOf(res.data) };
        setResults((prev) => ({ ...prev, [url]: load }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [url, known]);
  return url ? (results[url] ?? { state: "loading" }) : null;
}

export function ReviewBlock({
  output,
  messages,
  onApproved,
  onChanged,
}: {
  output: OutputView;
  messages: MessageView[];
  onApproved: (r: ApproveResult) => void;
  onChanged: () => void;
}) {
  const revisions = output.revisions;
  const [selectedId, setSelectedId] = useState<string | null>(output.currentRevisionId ?? revisions[0]?.id ?? null);
  const selected = revisions.find((r) => r.id === selectedId) ?? null;
  const current = revisions.find((r) => r.id === output.currentRevisionId) ?? null;

  const proofs = useCachedFetch<ProofsResponse>(
    selected ? `/api/admin/change-requests/revisions/${selected.id}/proofs` : null,
  );
  const diff = useCachedFetch<DiffResponse>(selected ? `/api/admin/change-requests/revisions/${selected.id}/diff` : null);

  const impact: ImpactSummary | null =
    proofs?.state === "ready"
      ? proofs.data.impact
      : selected && selected.id === output.currentRevisionId
        ? output.impact
        : null;
  const summary = selected
    ? latest(messages, (m) => m.authorKind === "AGENT" && m.revisionId === selected.id && m.kind === "message")
    : null;

  // Draft 1, 2, 3 … in the order they were made (revisions come newest first).
  const ordinal = new Map(revisions.map((r, i) => [r.id, revisions.length - i]));

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Proposed change</h2>
          {revisions.length > 0 && (
            <DraftSelector
              revisions={revisions}
              currentId={output.currentRevisionId}
              selectedId={selected?.id ?? null}
              ordinal={ordinal}
              onSelect={setSelectedId}
            />
          )}
        </div>
        {selected && selected.id !== output.currentRevisionId && (
          <p className="mt-2 rounded-md bg-subtle px-3 py-2 text-xs text-muted">
            You are looking at draft {ordinal.get(selected.id)} ({selected.status.toLowerCase()}). Approve applies to the current
            draft{current ? ` (draft ${ordinal.get(current.id)})` : ""}.
          </p>
        )}

        {summary && (
          <div className="mt-3 flex gap-2 rounded-md border border-line bg-subtle p-3">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
            <p className="whitespace-pre-wrap text-sm text-ink">{summary.body}</p>
          </div>
        )}

        {/* Proofs */}
        <div className="mt-4">
          <h3 className="text-xs font-medium text-muted">Before and after</h3>
          {!selected ? (
            <p className="mt-2 text-sm text-muted">No draft yet.</p>
          ) : proofs?.state === "ready" ? (
            proofs.data.picks.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No documents to show: no style prints this layout.</p>
            ) : (
              <div className="mt-2 grid gap-4 xl:grid-cols-2">
                {proofs.data.picks.map((p) => (
                  <ProofCard key={`${p.styleId}|${p.suffix ?? ""}`} revisionId={selected.id} pick={p} />
                ))}
              </div>
            )
          ) : proofs?.state === "error" ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-bad">
              <TriangleAlert className="h-4 w-4" aria-hidden />
              {proofs.message}
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              Picking documents to compare…
            </p>
          )}
        </div>
      </section>

      {/* Impact */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Which documents change</h2>
        {impact ? (
          <ImpactTable impact={impact} />
        ) : proofs?.state === "error" ? (
          <p className="mt-2 text-sm text-bad">{proofs.message}</p>
        ) : (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            Comparing every style that prints this layout…
          </p>
        )}
      </section>

      {/* Definition diff */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <FileDiff className="h-4 w-4 text-muted" aria-hidden />
          Layout changes
        </h2>
        {diff?.state === "ready" ? (
          <>
            {diff.data.changes.length === 0 ? (
              <p className="mt-2 text-sm text-muted">The draft doesn&apos;t change the layout definition.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm text-ink">
                {diff.data.changes.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 rounded bg-subtle px-1.5 text-[11px] font-medium text-muted">
                      {c.kind.replace("_", " ")}
                    </span>
                    <span>{c.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">Raw definitions (before / after)</summary>
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                <JsonBlock label="Before (live when the draft was made)" value={diff.data.before} />
                <JsonBlock label="After (this draft)" value={diff.data.after} />
              </div>
            </details>
          </>
        ) : diff?.state === "error" ? (
          <p className="mt-2 text-sm text-bad">{diff.message}</p>
        ) : selected ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            Loading…
          </p>
        ) : null}
      </section>

      <ApproveBar
        output={output}
        impact={selected?.id === output.currentRevisionId ? impact : output.impact}
        currentStatus={current?.status ?? null}
        onApproved={onApproved}
        onChanged={onChanged}
      />
    </div>
  );
}

function DraftSelector({
  revisions,
  currentId,
  selectedId,
  ordinal,
  onSelect,
}: {
  revisions: RevisionView[];
  currentId: string | null;
  selectedId: string | null;
  ordinal: Map<string, number>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Drafts">
      {revisions.map((r) => {
        const active = r.id === selectedId;
        const isCurrent = r.id === currentId;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(r.id)}
            title={`Revision #${r.number} · ${r.status.toLowerCase()} · ${r.createdLabel}`}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
              active ? "bg-primary text-white ring-accent" : "bg-surface text-muted ring-line hover:bg-subtle"
            }`}
          >
            Draft {ordinal.get(r.id)}
            {isCurrent ? " · current" : r.status !== "DRAFT" ? ` · ${r.status.toLowerCase()}` : ""}
          </button>
        );
      })}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium text-muted">{label}</div>
      <pre className="max-h-96 overflow-auto rounded-md bg-primary p-3 font-mono text-[11px] leading-relaxed text-faint">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

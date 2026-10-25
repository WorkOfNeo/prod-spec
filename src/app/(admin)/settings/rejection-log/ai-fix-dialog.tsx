"use client";

import { useEffect, useState } from "react";
import { PreviewFrame } from "@/components/output-preview";
import type { AiFixProposal } from "@/lib/rejection-ai/ai-fix";

// Render an (unsaved) layout definition against the rejected style via the
// live preview endpoint — the same renderer production uses. Returns the HTML,
// or null on any failure (the frame then shows a skeleton).
async function fetchLayoutPreview(p: AiFixProposal, definition: unknown): Promise<string | null> {
  try {
    const res = await fetch(`/api/admin/output-layouts/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition, layoutId: p.layoutId, styleId: p.styleId, format: "html" }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { html?: string };
    return body.html ?? null;
  } catch {
    return null;
  }
}

// The AI-fix dialog opened from a rejection ticket. Asks the AI for a proposed
// fix (POST …/ai-fix), renders the current output on the left and the proposed
// output on the right (both via the live preview endpoint against the rejected
// style, no save), and on "Keep changes" applies the edit to the layout +
// re-runs the output (POST …/ai-fix/apply). Nothing is written until Keep.
export function AiFixDialog({
  ticketId,
  outputName,
  styleName,
  styleNumber,
  comment,
  onClose,
  onApplied,
}: {
  ticketId: string;
  outputName: string;
  styleName: string;
  styleNumber: string;
  comment: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "applying" | "applied" | "error">("loading");
  const [proposal, setProposal] = useState<AiFixProposal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [beforeHtml, setBeforeHtml] = useState<string | null>(null);
  const [afterHtml, setAfterHtml] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setPhase("loading");
      setErr(null);
      try {
        const res = await fetch(`/api/admin/rejection-tickets/${ticketId}/ai-fix`, { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as { proposal?: AiFixProposal; error?: string };
        if (cancelled) return;
        if (!res.ok || !body.proposal) {
          setErr(body.error ?? `HTTP ${res.status}`);
          setPhase("error");
          return;
        }
        setProposal(body.proposal);
        setPhase("ready");
        // Render before/after in parallel (after = current when no edits).
        const p = body.proposal;
        const [before, after] = await Promise.all([
          fetchLayoutPreview(p, p.currentDef),
          p.edits.length > 0 ? fetchLayoutPreview(p, p.proposedDef) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setBeforeHtml(before);
        setAfterHtml(after);
      } catch {
        if (!cancelled) {
          setErr("Request failed — try again.");
          setPhase("error");
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  async function apply() {
    if (!proposal || proposal.edits.length === 0) return;
    setPhase("applying");
    setErr(null);
    try {
      const res = await fetch(`/api/admin/rejection-tickets/${ticketId}/ai-fix/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: proposal.proposedDef }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        rerun?: boolean;
        rerunError?: string;
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        setPhase("error");
        return;
      }
      setApplyMsg(
        body.rerun
          ? "Saved and re-run — the fixed output is regenerating. Mark the ticket fixed & notify when you're happy."
          : body.rerunError
            ? `Saved to the layout. The re-run didn't start (${body.rerunError}) — re-run the output from the workbench.`
            : "Saved to the layout.",
      );
      setPhase("applied");
      onApplied();
    } catch {
      setErr("Request failed — try again.");
      setPhase("error");
    }
  }

  const page = proposal?.currentDef.pages[0];
  const widthMm = page?.widthMm ?? 100;
  const heightMm = page?.heightMm ?? 75;
  const hasChange = (proposal?.edits.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(15_17_21/0.40)] px-4 py-8">
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">✨ AI fix — {outputName}</h2>
            <p className="truncate text-xs text-muted">
              {styleName} · <span className="font-mono">{styleNumber}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-xs text-muted underline">
            close
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase === "loading" ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Spinner />
              <p className="text-sm text-muted">Reading the rejection and drafting a fix…</p>
              <p className="max-w-md text-xs text-faint">
                The AI is looking at the reviewer&apos;s comment, the layout&apos;s variables, and what
                each one resolves to for this style.
              </p>
            </div>
          ) : phase === "error" ? (
            <div className="py-12 text-center">
              <p className="text-sm text-bad">{err ?? "Something went wrong."}</p>
            </div>
          ) : proposal ? (
            <div className="space-y-4">
              {/* Reviewer comment recap */}
              <div className="rounded-md border border-line bg-subtle px-3 py-2">
                <div className="text-[11px] font-bold text-faint">
                  Reviewer&apos;s comment
                </div>
                <p className="mt-1 text-xs whitespace-pre-wrap text-ink">{comment || "(none)"}</p>
              </div>

              {/* AI note / verdict */}
              {!proposal.isTemplateProblem ? (
                <div className="rounded-md border border-transparent bg-warn-soft px-3 py-2.5">
                  <div className="text-xs font-semibold text-warn">
                    The AI thinks this isn&apos;t a template problem
                  </div>
                  <p className="mt-1 text-xs text-warn">{proposal.note || "No template change proposed."}</p>
                </div>
              ) : (
                <div className="rounded-md border border-transparent bg-accent-soft px-3 py-2.5">
                  <div className="text-xs font-semibold text-accent-text">Proposed change</div>
                  <p className="mt-1 text-xs text-accent-text">{proposal.note || "See the preview on the right."}</p>
                </div>
              )}

              {/* Blast radius */}
              <p className="text-[11px] text-muted">
                Editing the layout <strong>{proposal.layoutName}</strong> changes it for{" "}
                <strong>
                  {proposal.usedByCount} prod spec{proposal.usedByCount === 1 ? "" : "s"}
                </strong>{" "}
                that use it — not just this style.
              </p>

              {/* Applied edits + skipped */}
              {hasChange ? (
                <details className="rounded-md border border-line bg-surface">
                  <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted">
                    {proposal.edits.length} line edit{proposal.edits.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="space-y-2 border-t border-line px-3 py-2">
                    {proposal.edits.map((e, i) => (
                      <li key={i} className="text-[11px]">
                        <div className="text-faint">
                          page {e.pageIndex} · block {e.blockIndex} · line {e.lineIndex}
                        </div>
                        <div className="font-mono text-bad line-through">{e.oldText || "(empty)"}</div>
                        <div className="font-mono text-good">{e.newText || "(empty)"}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {proposal.skipped.length > 0 ? (
                <p className="text-[11px] text-warn">
                  {proposal.skipped.length} suggested edit{proposal.skipped.length === 1 ? "" : "s"} skipped
                  (invalid variable or stale target).
                </p>
              ) : null}

              {/* Before / after */}
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-muted">Current (rejected)</div>
                  <div className="rounded-md border border-line bg-subtle p-2">
                    {beforeHtml ? (
                      <PreviewFrame html={beforeHtml} widthMm={widthMm} heightMm={heightMm} />
                    ) : (
                      <FrameSkeleton />
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-good">AI proposal</div>
                  <div className="rounded-md border border-transparent bg-emerald-50/40 p-2">
                    {!hasChange ? (
                      <div className="flex h-40 items-center justify-center px-4 text-center text-xs text-muted">
                        No template change proposed — nothing to preview.
                      </div>
                    ) : afterHtml ? (
                      <PreviewFrame html={afterHtml} widthMm={widthMm} heightMm={heightMm} />
                    ) : (
                      <FrameSkeleton />
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <div className="min-w-0 text-xs">
            {applyMsg ? <span className="text-good">{applyMsg}</span> : null}
            {err && phase !== "error" ? <span className="text-bad">{err}</span> : null}
          </div>
          <div className="flex shrink-0 gap-2">
            {phase === "applied" ? (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-subtle"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={phase !== "ready" || !hasChange}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  title={!hasChange ? "No change to keep" : "Apply this edit to the layout and re-run the output"}
                >
                  {phase === "applying" ? "Saving…" : "Keep changes"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-6 w-6 animate-spin text-accent-text" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

function FrameSkeleton() {
  return (
    <div className="flex h-40 animate-pulse items-center justify-center text-xs text-faint">
      Rendering preview…
    </div>
  );
}

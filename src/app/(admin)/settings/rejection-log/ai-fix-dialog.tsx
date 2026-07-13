"use client";

import { useEffect, useState } from "react";
import { PreviewFrame } from "@/components/output-preview";
import type { AiFixProposal } from "@/lib/rejection-ai/ai-fix";
import type { GeneralInfoAiFixProposal } from "@/lib/rejection-ai/general-info-fix";

// Either flavour of proposal, discriminated by `kind`.
type Proposal = AiFixProposal | GeneralInfoAiFixProposal;

// Render an (unsaved) LAYOUT definition against the rejected style via the live
// preview endpoint — the same renderer production uses. General-info proposals
// arrive with their before/after HTML already rendered server-side, so this is
// only used for the layout kind. Returns null on any failure (frame → skeleton).
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
// fix (POST …/ai-fix), shows the current output vs the proposal side by side
// (rendered against the real style / spec, no save), and on "Keep changes"
// applies the edit + re-runs the output (POST …/ai-fix/apply). Handles both an
// Output Builder layout (line-text edits) and the General information page
// (markdown rewrite). Nothing is written until Keep.
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
  const [proposal, setProposal] = useState<Proposal | null>(null);
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
        const body = (await res.json().catch(() => ({}))) as { proposal?: Proposal; error?: string };
        if (cancelled) return;
        if (!res.ok || !body.proposal) {
          setErr(body.error ?? `HTTP ${res.status}`);
          setPhase("error");
          return;
        }
        const p = body.proposal;
        setProposal(p);
        setPhase("ready");
        if (p.kind === "general-info") {
          // Rendered server-side already.
          setBeforeHtml(p.beforeHtml || null);
          setAfterHtml(p.changed ? p.afterHtml || null : null);
        } else {
          // Render before/after via the live layout preview endpoint.
          const [before, after] = await Promise.all([
            fetchLayoutPreview(p, p.currentDef),
            p.edits.length > 0 ? fetchLayoutPreview(p, p.proposedDef) : Promise.resolve(null),
          ]);
          if (cancelled) return;
          setBeforeHtml(before);
          setAfterHtml(after);
        }
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
    if (!proposal) return;
    const changed = proposal.kind === "layout" ? proposal.edits.length > 0 : proposal.changed;
    if (!changed) return;
    const applyBody =
      proposal.kind === "layout"
        ? { definition: proposal.proposedDef }
        : { markdown: proposal.proposedMarkdown };
    setPhase("applying");
    setErr(null);
    try {
      const res = await fetch(`/api/admin/rejection-tickets/${ticketId}/ai-fix/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(applyBody),
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
            ? `Saved. The re-run didn't start (${body.rerunError}) — re-run the output from the workbench.`
            : "Saved.",
      );
      setPhase("applied");
      onApplied();
    } catch {
      setErr("Request failed — try again.");
      setPhase("error");
    }
  }

  const hasChange = proposal ? (proposal.kind === "layout" ? proposal.edits.length > 0 : proposal.changed) : false;
  const widthMm = proposal
    ? proposal.kind === "layout"
      ? proposal.currentDef.pages[0]?.widthMm ?? 100
      : proposal.widthMm
    : 100;
  const heightMm = proposal
    ? proposal.kind === "layout"
      ? proposal.currentDef.pages[0]?.heightMm ?? 75
      : proposal.heightMm
    : 75;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900">✨ AI fix — {outputName}</h2>
            <p className="truncate text-xs text-zinc-500">
              {styleName} · <span className="font-mono">{styleNumber}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase === "loading" ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Spinner />
              <p className="text-sm text-zinc-600">Reading the rejection and drafting a fix…</p>
              <p className="max-w-md text-xs text-zinc-400">
                The AI is looking at the reviewer&apos;s comment and the current content, and working out
                the smallest change that resolves it.
              </p>
            </div>
          ) : phase === "error" ? (
            <div className="py-12 text-center">
              <p className="text-sm text-red-600">{err ?? "Something went wrong."}</p>
            </div>
          ) : proposal ? (
            <div className="space-y-4">
              {/* Reviewer comment recap */}
              <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">
                  Reviewer&apos;s comment
                </div>
                <p className="mt-1 text-xs whitespace-pre-wrap text-zinc-700">{comment || "(none)"}</p>
              </div>

              {/* AI note / verdict */}
              {!proposal.isTemplateProblem ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
                  <div className="text-xs font-semibold text-amber-800">
                    The AI thinks this can&apos;t be fixed here
                  </div>
                  <p className="mt-1 text-xs text-amber-800">{proposal.note || "No change proposed."}</p>
                </div>
              ) : (
                <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2.5">
                  <div className="text-xs font-semibold text-violet-800">Proposed change</div>
                  <p className="mt-1 text-xs text-violet-900">{proposal.note || "See the preview on the right."}</p>
                </div>
              )}

              {/* Blast radius */}
              {proposal.kind === "layout" ? (
                <p className="text-[11px] text-zinc-500">
                  Editing the layout <strong>{proposal.layoutName}</strong> changes it for{" "}
                  <strong>
                    {proposal.usedByCount} prod spec{proposal.usedByCount === 1 ? "" : "s"}
                  </strong>{" "}
                  that use it — not just this style.
                </p>
              ) : (
                <p className="text-[11px] text-zinc-500">
                  Editing this <strong>General information</strong> page changes it for{" "}
                  <strong>
                    {proposal.usedByCount} style{proposal.usedByCount === 1 ? "" : "s"}
                  </strong>{" "}
                  on Prod Spec <strong>{proposal.prodSpecName}</strong> — not just this style.
                </p>
              )}

              {/* What changed */}
              {proposal.kind === "layout" ? (
                <>
                  {hasChange ? (
                    <details className="rounded-md border border-zinc-200 bg-white">
                      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-zinc-600">
                        {proposal.edits.length} line edit{proposal.edits.length === 1 ? "" : "s"}
                      </summary>
                      <ul className="space-y-2 border-t border-zinc-100 px-3 py-2">
                        {proposal.edits.map((e, i) => (
                          <li key={i} className="text-[11px]">
                            <div className="text-zinc-400">
                              page {e.pageIndex} · block {e.blockIndex} · line {e.lineIndex}
                            </div>
                            <div className="font-mono text-red-600 line-through">{e.oldText || "(empty)"}</div>
                            <div className="font-mono text-emerald-700">{e.newText || "(empty)"}</div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {proposal.skipped.length > 0 ? (
                    <p className="text-[11px] text-amber-600">
                      {proposal.skipped.length} suggested edit{proposal.skipped.length === 1 ? "" : "s"} skipped
                      (invalid variable or stale target).
                    </p>
                  ) : null}
                </>
              ) : hasChange ? (
                <details className="rounded-md border border-zinc-200 bg-white">
                  <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-zinc-600">
                    View the proposed markdown
                  </summary>
                  <pre className="max-h-64 overflow-auto border-t border-zinc-100 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-700">
                    {proposal.proposedMarkdown}
                  </pre>
                </details>
              ) : null}

              {/* Before / after */}
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-zinc-500">Current (rejected)</div>
                  <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
                    {beforeHtml ? (
                      <PreviewFrame html={beforeHtml} widthMm={widthMm} heightMm={heightMm} />
                    ) : (
                      <FrameSkeleton />
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-emerald-700">AI proposal</div>
                  <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-2">
                    {!hasChange ? (
                      <div className="flex h-40 items-center justify-center px-4 text-center text-xs text-zinc-500">
                        No change proposed — nothing to preview.
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
        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-5 py-3">
          <div className="min-w-0 text-xs">
            {applyMsg ? <span className="text-emerald-700">{applyMsg}</span> : null}
            {err && phase !== "error" ? <span className="text-red-600">{err}</span> : null}
          </div>
          <div className="flex shrink-0 gap-2">
            {phase === "applied" ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={phase !== "ready" || !hasChange}
                  className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  title={!hasChange ? "No change to keep" : "Apply this edit and re-run the output"}
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
    <svg className="h-6 w-6 animate-spin text-violet-600" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

function FrameSkeleton() {
  return (
    <div className="flex h-40 animate-pulse items-center justify-center text-xs text-zinc-400">
      Rendering preview…
    </div>
  );
}

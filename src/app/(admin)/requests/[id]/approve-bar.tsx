"use client";

import { useState } from "react";
import { CircleCheck, LayoutTemplate, LoaderCircle, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import type { ImpactRow, ImpactSummary } from "@/lib/change-requests/types";
import type { OutputView } from "@/lib/change-requests/review-view";
import { errorOf, plural, sendJson } from "./shared";

// Approve / Reject for an output whose current draft is in review (ADMIN).
//
// Approve is two clicks: the first says what publishing will do (from the
// draft's impact), the second publishes. Both send the draft that was on
// screen when the admin clicked (`revisionId`): the route refuses with 409 "A
// newer draft exists — reload" when another one landed meanwhile, and with a
// `conflict` when the layout moved since the draft was made — shown with what
// moved and a "Publish anyway" that sends force — and 422 with the publish
// gate's details. Reject needs a reason; it goes to the requester.
//
// A current draft that is already live (published from the layout's History
// panel, or an approval that stopped half way) gets "Finish publishing": the
// same approve call, which then only reruns and records. A draft another
// publish replaced can only be rejected or revised in the thread.

// The approve route's 200 body (publish.ts ApproveResult, as JSON).
export type ApproveResult = {
  publishedVersion: number;
  forced: boolean;
  rerun: {
    enqueued: number;
    batchId: string | null;
    skippedNoPo: number;
    skippedBelowCutoff: number;
    documents: number;
    skippedInFlight: number;
    error: string | null;
  };
  approvedChanged: ImpactRow[];
  deliveredChanged: ImpactRow[];
  impactError: string | null;
  summary: string;
};

type Conflict = { baseVersion: number; liveVersion: number; versionChanged: boolean; definitionChanged: boolean };
type Failure = { message: string; details?: string[]; conflict?: Conflict };
type ApproveResponse = ApproveResult & { error?: string; details?: string[]; conflict?: Conflict };

const REJECT_MAX = 500;

// The two actions every surface of the review screen sends (ApproveBar, the
// status panels, the stale-claim "Finish publishing").
export function postApprove(outputId: string, revisionId: string, force: boolean) {
  return sendJson<ApproveResponse>(`/api/admin/change-request-outputs/${outputId}/approve`, "POST", {
    revisionId,
    ...(force ? { force: true } : {}),
  });
}

export function postReject(outputId: string, reason: string) {
  return sendJson<{ error?: string; details?: string[] }>(`/api/admin/change-request-outputs/${outputId}/reject`, "POST", {
    reason: reason.trim(),
  });
}

export function ApproveBar({
  output,
  impact,
  currentStatus,
  onApproved,
  onChanged,
}: {
  output: OutputView;
  // The current draft's impact, when known — for the confirm text.
  impact: ImpactSummary | null;
  // The current revision's status: DRAFT (approvable), PUBLISHED (already
  // live: finish publishing) or anything else (replaced by another publish).
  currentStatus: string | null;
  onApproved: (r: ApproveResult) => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "confirm" | "reject">("idle");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reason, setReason] = useState("");
  // The draft on screen when "Approve" was clicked: what the confirm step and
  // "Publish anyway" approve, even if a poll swaps in a newer one meanwhile.
  const [approving, setApproving] = useState<string | null>(null);

  const draftOpen = currentStatus === "DRAFT";
  const alreadyLive = currentStatus === "PUBLISHED";

  const switchTo = (next: "idle" | "confirm" | "reject") => {
    setMode(next);
    setFailure(null);
    if (next === "confirm") setApproving(output.currentRevisionId);
  };

  const approve = async (force: boolean) => {
    const revisionId = approving ?? output.currentRevisionId;
    if (!revisionId) return;
    setBusy(true);
    setFailure(null);
    const res = await postApprove(output.id, revisionId, force);
    setBusy(false);
    if (res.ok) {
      onApproved(res.data);
      setMode("idle");
      onChanged();
      return;
    }
    setFailure({ message: errorOf(res.data), details: res.data.details, conflict: res.data.conflict });
  };

  const reject = async () => {
    setBusy(true);
    setFailure(null);
    const res = await postReject(output.id, reason);
    setBusy(false);
    if (res.ok) {
      setMode("idle");
      onChanged();
      return;
    }
    setFailure({ message: errorOf(res.data), details: res.data.details });
  };

  const pending = impact ? impact.rows.filter((r) => r.changed && r.reviewStatus !== "APPROVED" && !r.inFlight).length : null;

  return (
    <section className="sticky bottom-0 z-10 rounded-xl border border-line bg-surface p-4 shadow-lg">
      {alreadyLive ? (
        <p className="flex items-start gap-2 text-sm text-warn">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          This draft is already live (published from the layout&apos;s history, or an approval stopped half way). Finish
          publishing to rerun the changed documents and mark this output live.
        </p>
      ) : !draftOpen && mode !== "reject" ? (
        <p className="flex items-start gap-2 text-sm text-warn">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          This draft was replaced by another publish; ask the agent for a new draft in the thread.
        </p>
      ) : mode === "confirm" ? (
        <div className="space-y-2 text-sm text-ink">
          <p className="font-medium text-ink">Publish “{output.label}”?</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>The draft becomes the live layout (a new version).</li>
            {pending !== null && (
              <li>
                About {plural(pending, "changed document")} go{pending === 1 ? "es" : ""} back to review with the new layout
                (worked out again on publish).
              </li>
            )}
            {impact && impact.counts.approvedChanged > 0 && (
              <li>
                {plural(impact.counts.approvedChanged, "approved document")} change{impact.counts.approvedChanged === 1 ? "s" : ""}{" "}
                but stay{impact.counts.approvedChanged === 1 ? "s" : ""} as approved; you can send them back to review afterwards.
              </li>
            )}
            <li>Nothing is sent to a supplier.</li>
          </ul>
        </div>
      ) : mode === "reject" ? (
        <div>
          <label htmlFor={`reject-${output.id}`} className="text-sm font-medium text-ink">
            Why is this change rejected?
          </label>
          <p className="text-xs text-muted">The requester gets this in an email. The layout stays as it is.</p>
          <textarea
            id={`reject-${output.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REJECT_MAX))}
            rows={3}
            disabled={busy}
            className="mt-2 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <p className="text-right text-[11px] text-faint">
            {reason.length}/{REJECT_MAX}
          </p>
        </div>
      ) : null}

      {failure && (
        <div className="mt-2 rounded-md border border-transparent bg-bad-soft p-3 text-sm text-bad">
          <p>{failure.message}</p>
          {failure.conflict && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {failure.conflict.versionChanged && (
                <li>
                  The layout was published again (version {failure.conflict.baseVersion} → {failure.conflict.liveVersion}).
                </li>
              )}
              {failure.conflict.definitionChanged && <li>The layout was edited in the Output Builder.</li>}
              <li>“Publish anyway” overwrites those changes with this draft; asking the agent for a new draft keeps them.</li>
            </ul>
          )}
          {failure.details && failure.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {failure.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={`flex flex-wrap items-center gap-2 ${mode !== "idle" || failure || !draftOpen ? "mt-3" : ""}`}>
        {mode === "reject" ? (
          <>
            <button
              type="button"
              onClick={reject}
              disabled={busy || !reason.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-bad px-3 py-2 text-sm font-medium text-white hover:bg-bad disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ThumbsDown className="h-4 w-4" aria-hidden />}
              Reject
            </button>
            <CancelButton disabled={busy} onClick={() => switchTo("idle")} />
          </>
        ) : (
          <>
            {alreadyLive ? (
              <button
                type="button"
                onClick={() => approve(false)}
                disabled={busy}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <CircleCheck className="h-4 w-4" aria-hidden />}
                {busy ? "Finishing…" : "Finish publishing"}
              </button>
            ) : draftOpen && failure?.conflict ? (
              <button
                type="button"
                onClick={() => approve(true)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-warn px-3 py-2 text-sm font-medium text-white hover:bg-warn disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <TriangleAlert className="h-4 w-4" aria-hidden />}
                Publish anyway
              </button>
            ) : draftOpen && mode === "confirm" ? (
              <button
                type="button"
                onClick={() => approve(false)}
                disabled={busy}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ThumbsUp className="h-4 w-4" aria-hidden />}
                {busy ? "Publishing…" : "Approve and publish"}
              </button>
            ) : draftOpen ? (
              <button
                type="button"
                onClick={() => switchTo("confirm")}
                disabled={busy}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ThumbsUp className="h-4 w-4" aria-hidden />
                Approve {output.label}
              </button>
            ) : null}
            {(mode === "confirm" || failure?.conflict) && (
              <CancelButton disabled={busy} onClick={() => switchTo("idle")} />
            )}
            {/* An already-live draft can't be rejected (rejectOutput refuses). */}
            {mode === "idle" && !failure?.conflict && !alreadyLive && (
              <button
                type="button"
                onClick={() => switchTo("reject")}
                disabled={busy}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ThumbsDown className="h-4 w-4" aria-hidden />
                Reject…
              </button>
            )}
          </>
        )}
        {/* What approving publishes: the admin sees which layout before the click. */}
        <LayoutLabel output={output} className="sm:ml-auto" />
      </div>
    </section>
  );
}

// The layout an output's drafts change — by name and id, so the admin knows
// exactly what an approval publishes. "Pinned by the agent" when no configured
// output was picked at filing and a run chose the layout (find_layouts).
export function LayoutLabel({
  output,
  className = "",
}: {
  output: Pick<OutputView, "layoutId" | "layoutName" | "layoutPinnedByAgent">;
  className?: string;
}) {
  if (!output.layoutId) return null;
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted ${className}`}>
      <LayoutTemplate className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Layout <span className="font-medium text-ink">{output.layoutName ?? "unnamed"}</span>
      </span>
      <code className="break-all rounded bg-subtle px-1 font-mono text-[11px] text-muted">{output.layoutId}</code>
      {output.layoutPinnedByAgent && (
        <span
          title="No configured output was picked when the request was filed; the agent chose this layout."
          className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn ring-1 ring-inset ring-amber-200"
        >
          pinned by the agent
        </span>
      )}
    </span>
  );
}

// Reject for an output with no draft to approve (NEW, FAILED, NEEDS_INFO,
// NEEDS_CODE, in review with only a question): every open state can be
// closed. The reason is required and goes to the requester.
export function RejectControl({ outputId, onChanged }: { outputId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ThumbsDown className="h-4 w-4" aria-hidden />
        Reject…
      </button>
    );
  }

  const reject = async () => {
    setBusy(true);
    setError(null);
    const res = await postReject(outputId, reason);
    setBusy(false);
    if (!res.ok) return setError(errorOf(res.data));
    setOpen(false);
    onChanged();
  };

  return (
    <div className="basis-full rounded-md border border-line bg-surface p-3">
      <label htmlFor={`reject-${outputId}`} className="text-sm font-medium text-ink">
        Why is this request rejected?
      </label>
      <p className="text-xs text-muted">The requester gets this in an email. The layout stays as it is.</p>
      <textarea
        id={`reject-${outputId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, REJECT_MAX))}
        rows={3}
        disabled={busy}
        className="mt-2 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={reject}
          disabled={busy || !reason.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-bad px-3 py-1.5 text-sm font-medium text-white hover:bg-bad disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ThumbsDown className="h-4 w-4" aria-hidden />}
          Reject
        </button>
        <CancelButton disabled={busy} onClick={() => setOpen(false)} />
        <span className="ml-auto text-[11px] text-faint">
          {reason.length}/{REJECT_MAX}
        </span>
      </div>
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

// An output left APPROVED by an approval that stopped half way. The server
// refuses while the approval may still be running (409), so this is safe to
// offer at once.
export function FinishPublishingButton({
  output,
  onApproved,
  onChanged,
}: {
  output: OutputView;
  onApproved: (r: ApproveResult) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revisionId = output.currentRevisionId;
  if (!revisionId) return null;
  const finish = async () => {
    setBusy(true);
    setError(null);
    const res = await postApprove(output.id, revisionId, false);
    setBusy(false);
    if (!res.ok) return setError(errorOf(res.data));
    onApproved(res.data);
    onChanged();
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={finish}
        disabled={busy}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <CircleCheck className="h-4 w-4" aria-hidden />}
        Finish publishing
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}

function CancelButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-3 py-2 text-sm text-muted hover:bg-subtle disabled:opacity-50"
    >
      Cancel
    </button>
  );
}

// What an approval just did, shown above the "live" panel.
export function ApproveResultView({ result }: { result: ApproveResult }) {
  return (
    <section className="rounded-lg border border-transparent bg-good-soft p-4 text-sm text-good">
      <h2 className="flex items-center gap-2 font-semibold">
        <CircleCheck className="h-4 w-4" aria-hidden />
        Published as version {result.publishedVersion}
      </h2>
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Styles rerun" value={result.rerun.enqueued} />
        <Stat label="Changed docs rerun" value={result.rerun.documents} />
        <Stat label="Approved, changed" value={result.approvedChanged.length} />
        <Stat label="Already delivered" value={result.deliveredChanged.length} />
      </dl>
      <p className="mt-2 text-good">{result.summary}</p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-white/70 px-2 py-1.5">
      <dt className="text-[11px] text-good">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value.toLocaleString("en")}</dd>
    </div>
  );
}

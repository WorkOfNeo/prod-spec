"use client";

import { useState } from "react";
import { CircleCheck, LayoutTemplate, LoaderCircle, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import type { ImpactRow, ImpactSummary } from "@/lib/change-requests/types";
import type { OutputView } from "@/lib/change-requests/review-view";
import { errorOf, plural, sendJson } from "./shared";

// Approve / Reject for an output whose current draft is in review (ADMIN).
//
// Approve is two clicks: the first says what publishing will do (from the
// draft's impact), the second publishes. The route answers 409 with a
// `conflict` when the layout moved since the draft was made — shown with what
// moved and a "Publish anyway" that sends force — and 422 with the publish
// gate's details. Reject needs a reason; it goes to the requester.

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

const REJECT_MAX = 500;

export function ApproveBar({
  output,
  impact,
  draftOpen,
  onApproved,
  onChanged,
}: {
  output: OutputView;
  // The current draft's impact, when known — for the confirm text.
  impact: ImpactSummary | null;
  // The current revision is still a DRAFT (not replaced by another publish).
  draftOpen: boolean;
  onApproved: (r: ApproveResult) => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "confirm" | "reject">("idle");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reason, setReason] = useState("");

  const switchTo = (next: "idle" | "confirm" | "reject") => {
    setMode(next);
    setFailure(null);
  };

  const approve = async (force: boolean) => {
    setBusy(true);
    setFailure(null);
    const res = await sendJson<ApproveResult & { error?: string; details?: string[]; conflict?: Conflict }>(
      `/api/admin/change-request-outputs/${output.id}/approve`,
      "POST",
      force ? { force: true } : {},
    );
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
    const res = await sendJson(`/api/admin/change-request-outputs/${output.id}/reject`, "POST", { reason: reason.trim() });
    setBusy(false);
    if (res.ok) {
      setMode("idle");
      onChanged();
      return;
    }
    setFailure({ message: errorOf(res.data), details: (res.data as { details?: string[] }).details });
  };

  const pending = impact ? impact.rows.filter((r) => r.changed && r.reviewStatus !== "APPROVED" && !r.inFlight).length : null;

  return (
    <section className="sticky bottom-0 z-10 rounded-lg border border-zinc-300 bg-white p-4 shadow-lg">
      {!draftOpen ? (
        <p className="flex items-start gap-2 text-sm text-amber-800">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          This draft was replaced by another publish; ask the agent for a new draft in the thread.
        </p>
      ) : mode === "confirm" ? (
        <div className="space-y-2 text-sm text-zinc-700">
          <p className="font-medium text-zinc-900">Publish “{output.label}”?</p>
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
          <label htmlFor={`reject-${output.id}`} className="text-sm font-medium text-zinc-900">
            Why is this change rejected?
          </label>
          <p className="text-xs text-zinc-500">The requester gets this in an email. The layout stays as it is.</p>
          <textarea
            id={`reject-${output.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REJECT_MAX))}
            rows={3}
            disabled={busy}
            className="mt-2 w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
          <p className="text-right text-[11px] text-zinc-400">
            {reason.length}/{REJECT_MAX}
          </p>
        </div>
      ) : null}

      {failure && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
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
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ThumbsDown className="h-4 w-4" aria-hidden />}
              Reject
            </button>
            <CancelButton disabled={busy} onClick={() => switchTo("idle")} />
          </>
        ) : (
          <>
            {draftOpen && failure?.conflict ? (
              <button
                type="button"
                onClick={() => approve(true)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <TriangleAlert className="h-4 w-4" aria-hidden />}
                Publish anyway
              </button>
            ) : draftOpen && mode === "confirm" ? (
              <button
                type="button"
                onClick={() => approve(false)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ThumbsUp className="h-4 w-4" aria-hidden />}
                {busy ? "Publishing…" : "Approve and publish"}
              </button>
            ) : draftOpen ? (
              <button
                type="button"
                onClick={() => switchTo("confirm")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <ThumbsUp className="h-4 w-4" aria-hidden />
                Approve {output.label}
              </button>
            ) : null}
            {(mode === "confirm" || failure?.conflict) && (
              <CancelButton disabled={busy} onClick={() => switchTo("idle")} />
            )}
            {mode === "idle" && !failure?.conflict && (
              <button
                type="button"
                onClick={() => switchTo("reject")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
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
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-zinc-500 ${className}`}>
      <LayoutTemplate className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Layout <span className="font-medium text-zinc-800">{output.layoutName ?? "unnamed"}</span>
      </span>
      <code className="break-all rounded bg-zinc-100 px-1 font-mono text-[11px] text-zinc-600">{output.layoutId}</code>
      {output.layoutPinnedByAgent && (
        <span
          title="No configured output was picked when the request was filed; the agent chose this layout."
          className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200"
        >
          pinned by the agent
        </span>
      )}
    </span>
  );
}

function CancelButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
    >
      Cancel
    </button>
  );
}

// What an approval just did, shown above the "live" panel.
export function ApproveResultView({ result }: { result: ApproveResult }) {
  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
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
      <p className="mt-2 text-emerald-900">{result.summary}</p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-white/70 px-2 py-1.5">
      <dt className="text-[11px] uppercase tracking-wide text-emerald-700">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value.toLocaleString("en")}</dd>
    </div>
  );
}

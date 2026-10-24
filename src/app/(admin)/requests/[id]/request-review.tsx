"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  CircleCheck,
  CircleHelp,
  Code,
  ExternalLink,
  Hourglass,
  LoaderCircle,
  Play,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import type { OutputView, RequestView } from "@/lib/change-requests/review-view";
import { useVisiblePoll } from "@/lib/use-visible-poll";
import { OUTPUT_STATUS_META, StatusPill } from "../status-pill";
import {
  ApproveResultView,
  FinishPublishingButton,
  LayoutLabel,
  RejectControl,
  type ApproveResult,
} from "./approve-bar";
import { PublishedPanel } from "./published-panel";
import { ReviewBlock } from "./review-block";
import { RunLog, LiveSteps } from "./run-log";
import { Thread } from "./thread";
import {
  attachmentUrl,
  currentRunSteps,
  errorOf,
  latest,
  latestAgentWord,
  messagesFor,
  openQuestion,
  sendJson,
  stepsFor,
} from "./shared";

// The review screen's client half: a tab per output, and for the selected
// output what was asked, what the agent did (by status), the thread and the
// run log. The page renders the first view on the server; while an output is
// WORKING this polls GET /api/admin/change-requests/[id] every 3 s and keeps
// whichever view is newest (the page's props after a router.refresh(), or the
// last poll). Every action fetches, then router.refresh().

const POLL_MS = 3_000;

// What a poll must notice to refresh the server-rendered parts (the header's
// request status, the tabs).
function statusKey(view: RequestView): string {
  return [view.status, ...view.outputs.map((o) => `${o.id}:${o.status}:${o.currentRevisionId ?? ""}`)].join("|");
}

export function RequestReview({ view: initial, initialOutputId }: { view: RequestView; initialOutputId: string | null }) {
  const router = useRouter();
  const [polled, setPolled] = useState<RequestView | null>(null);
  const view = polled && polled.generatedAt > initial.generatedAt ? polled : initial;
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initial.outputs.find((o) => o.id === initialOutputId)?.id ?? initial.outputs[0]?.id ?? null,
  );
  // Approve results of this session, per output, so the "live" panel can show
  // exactly what the click did after the refresh swaps the review block out.
  const [approved, setApproved] = useState<Record<string, ApproveResult>>({});

  const output = view.outputs.find((o) => o.id === selectedId) ?? view.outputs[0] ?? null;
  const anyWorking = view.outputs.some((o) => o.status === "WORKING");

  useVisiblePoll(async (signal) => {
    if (!anyWorking) return;
    try {
      const res = await fetch(`/api/admin/change-requests/${view.id}`, { cache: "no-store", signal });
      if (!res.ok) return;
      const next = (await res.json()) as RequestView;
      const changed = statusKey(next) !== statusKey(view);
      setPolled(next);
      if (changed) router.refresh();
    } catch {
      // Aborted on unmount, or offline: the next tick tries again.
    }
  }, POLL_MS);

  const refresh = () => router.refresh();
  const select = (id: string) => {
    setSelectedId(id);
    // Deep-linkable tab without a server round trip.
    window.history.replaceState(null, "", `?output=${encodeURIComponent(id)}`);
  };

  if (!output) {
    return <p className="text-sm text-zinc-500">This request has no outputs.</p>;
  }

  return (
    <div>
      <OutputTabs outputs={view.outputs} selectedId={output.id} onSelect={select} />
      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <WhatTheyAsked view={view} output={output} />
          {view.admin ? (
            <AdminBody
              key={output.id}
              view={view}
              output={output}
              approveResult={approved[output.id] ?? null}
              onApproved={(r) => setApproved((prev) => ({ ...prev, [output.id]: r }))}
              onChanged={refresh}
            />
          ) : (
            <RequesterBody view={view} output={output} />
          )}
          {view.admin && <RunLog steps={stepsFor(view, output.id)} />}
        </div>
        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <Thread key={output.id} view={view} output={output} onChanged={refresh} />
        </aside>
      </div>
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function OutputTabs({
  outputs,
  selectedId,
  onSelect,
}: {
  outputs: OutputView[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-zinc-200" role="tablist" aria-label="Outputs">
      {outputs.map((o) => {
        const active = o.id === selectedId;
        const meta = OUTPUT_STATUS_META[o.status] ?? { label: o.status, tone: "zinc" as const };
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(o.id)}
            className={`-mb-px inline-flex items-center gap-2 rounded-t-md border px-3 py-2 text-sm ${
              active
                ? "border-zinc-200 border-b-white bg-white font-medium text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-900"
            }`}
          >
            <span className="max-w-[16rem] truncate">{o.label}</span>
            <StatusPill label={meta.label} tone={meta.tone} />
          </button>
        );
      })}
    </div>
  );
}

// ── What they asked ──────────────────────────────────────────────────────────

function WhatTheyAsked({ view, output }: { view: RequestView; output: OutputView }) {
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const shots = [
    ...output.attachments.map((a) => ({ ...a, general: false })),
    ...view.generalAttachments.map((a) => ({ ...a, general: true })),
  ];
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">What they asked</h2>
        {view.admin && <LayoutLabel output={output} />}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-800">{output.text}</p>
      {shots.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {shots.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen({ id: a.id, name: a.fileName })}
              title={a.general ? `${a.fileName} (for the whole request)` : a.fileName}
              className="group relative overflow-hidden rounded-md ring-1 ring-zinc-200 hover:ring-zinc-400"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- private, session-gated bytes */}
              <img src={attachmentUrl(view.id, a.id)} alt={a.fileName} className="h-20 w-24 object-cover" loading="lazy" />
              {a.general && (
                <span className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 text-[10px] text-white">Whole request</span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={open.name}
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
        >
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="absolute right-4 top-4 rounded-full bg-white/90 p-1.5 text-zinc-700 hover:bg-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- private, session-gated bytes */}
          <img
            src={attachmentUrl(view.id, open.id)}
            alt={open.name}
            className="max-h-full max-w-full rounded bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </section>
  );
}

// ── Admin: what to do next, by status ────────────────────────────────────────

function AdminBody({
  view,
  output,
  approveResult,
  onApproved,
  onChanged,
}: {
  view: RequestView;
  output: OutputView;
  approveResult: ApproveResult | null;
  onApproved: (r: ApproveResult) => void;
  onChanged: () => void;
}) {
  const messages = messagesFor(view, output.id);
  const question = openQuestion(messages, output.id);
  // Every open state can be closed (Reject, with a reason) and, where the
  // agent stopped, started again.
  const actions = (run?: { label: string; again?: boolean }) => (
    <div className="mt-3 flex flex-wrap items-start gap-2">
      {run && <RunButton requestId={view.id} outputId={output.id} label={run.label} again={run.again} onChanged={onChanged} />}
      <RejectControl outputId={output.id} onChanged={onChanged} />
    </div>
  );

  switch (output.status) {
    case "NEW":
      return (
        <Panel tone="zinc" icon={<Play className="h-4 w-4" aria-hidden />} title="The agent hasn't started on this output">
          {actions({ label: "Start the agent" })}
        </Panel>
      );
    case "WORKING":
      return (
        <Panel
          tone="blue"
          icon={<LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
          title="The agent is working…"
        >
          <p className="text-sm text-zinc-600">This page updates by itself. Nothing prints differently until you approve a draft.</p>
          <LiveSteps steps={currentRunSteps(stepsFor(view, output.id))} />
        </Panel>
      );
    case "IN_REVIEW":
      if (!output.currentRevisionId) {
        // No draft: the agent either asked something, or finished without
        // proposing a change and said why (a plain message). Either way the
        // admin replies in the thread (a new run), runs it again, or closes it.
        const word = latestAgentWord(messages, output.id);
        if (word && word.kind === "message") {
          return (
            <AgentAnsweredPanel answer={word.body}>
              {actions({ label: "Run the agent again", again: true })}
            </AgentAnsweredPanel>
          );
        }
        return (
          <QuestionPanel question={question?.body ?? null} waitingFor="you">
            {actions({ label: "Run the agent again", again: true })}
          </QuestionPanel>
        );
      }
      return (
        <ReviewBlock output={output} messages={messages} onApproved={onApproved} onChanged={onChanged} />
      );
    case "NEEDS_INFO":
      return (
        <QuestionPanel question={question?.body ?? null} waitingFor="the requester">
          {actions()}
        </QuestionPanel>
      );
    case "NEEDS_CODE":
      return (
        <NeedsCodePanel view={view} output={output}>
          {actions({ label: "Run the agent again", again: true })}
        </NeedsCodePanel>
      );
    case "FAILED": {
      const reason = latest(messages, (m) => m.outputId === output.id && m.authorKind === "SYSTEM");
      return (
        <Panel tone="red" icon={<TriangleAlert className="h-4 w-4" aria-hidden />} title="The agent run failed">
          {reason && <p className="whitespace-pre-wrap text-sm text-zinc-700">{reason.body}</p>}
          {actions({ label: "Run again", again: true })}
        </Panel>
      );
    }
    case "PUBLISHED":
      return (
        <>
          {approveResult && <ApproveResultView result={approveResult} />}
          <PublishedPanel output={output} onChanged={onChanged} />
        </>
      );
    case "REJECTED":
      return (
        <Panel tone="zinc" icon={<X className="h-4 w-4" aria-hidden />} title="Rejected — the layout stays as it is">
          {output.rejectReason && <p className="whitespace-pre-wrap text-sm text-zinc-700">{output.rejectReason}</p>}
        </Panel>
      );
    case "APPROVED":
      return (
        <Panel tone="green" icon={<CircleCheck className="h-4 w-4" aria-hidden />} title="Approved — publishing">
          <p className="text-sm text-zinc-600">
            An approval is publishing this draft. If this doesn&apos;t change within a few minutes, the approval stopped
            half way: finish it here.
          </p>
          <FinishPublishingButton output={output} onApproved={onApproved} onChanged={onChanged} />
        </Panel>
      );
    default:
      return null;
  }
}

function NeedsCodePanel({
  view,
  output,
  children,
}: {
  view: RequestView;
  output: OutputView;
  children?: React.ReactNode;
}) {
  const spec = output.codeSpec;
  return (
    <Panel tone="orange" icon={<Code className="h-4 w-4" aria-hidden />} title="This change needs new code first">
      {spec ? (
        <div className="space-y-2 text-sm text-zinc-700">
          <p>
            A new value, <code className="rounded bg-zinc-100 px-1 font-mono text-xs">{`{{${spec.tokenKey}}}`}</code>{" "}
            ({spec.label}), from {spec.board} → {spec.column}.
          </p>
          <p className="whitespace-pre-wrap">{spec.rule}</p>
          <p className="text-xs text-zinc-500">
            {spec.cases} worked example{spec.cases === 1 ? "" : "s"}. The agent picks this up again by itself once the value is
            live.
          </p>
        </div>
      ) : (
        <p className="text-sm text-zinc-600">
          {output.awaitingToken ? `Waiting for {{${output.awaitingToken}}}.` : "The agent handed this to the developer."}
        </p>
      )}
      <a
        href={`/requests/${view.id}/build-prompt?output=${encodeURIComponent(output.id)}`}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        Get build prompt
      </a>
      {children}
    </Panel>
  );
}

function QuestionPanel({
  question,
  waitingFor,
  children,
}: {
  question: string | null;
  waitingFor: "you" | "the requester";
  children?: React.ReactNode;
}) {
  return (
    <Panel
      tone={waitingFor === "you" ? "amber" : "violet"}
      icon={waitingFor === "you" ? <CircleHelp className="h-4 w-4" aria-hidden /> : <Hourglass className="h-4 w-4" aria-hidden />}
      title={waitingFor === "you" ? "The agent has a question" : "Waiting for the requester"}
    >
      {question ? (
        <blockquote className="whitespace-pre-wrap rounded-md border-l-4 border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {question}
        </blockquote>
      ) : (
        <p className="text-sm text-zinc-600">The question is in the thread.</p>
      )}
      <p className="mt-2 text-xs text-zinc-500">
        {waitingFor === "you"
          ? "Answer in the thread; the agent continues with your answer."
          : "They were emailed the question. Their answer in the thread restarts the agent."}
      </p>
      {children}
    </Panel>
  );
}

// The agent finished without a draft and explained why ("this already prints",
// or an answer to a question in the thread).
function AgentAnsweredPanel({ answer, children }: { answer: string; children?: React.ReactNode }) {
  return (
    <Panel tone="amber" icon={<Bot className="h-4 w-4" aria-hidden />} title="The agent answered — no change proposed">
      <blockquote className="whitespace-pre-wrap rounded-md border-l-4 border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800">
        {answer}
      </blockquote>
      <p className="mt-2 text-xs text-zinc-500">
        Reply in the thread to start a new run, run the agent again, or close the request with a reason.
      </p>
      {children}
    </Panel>
  );
}

// ── Requester: where it stands ───────────────────────────────────────────────

function RequesterBody({ view, output }: { view: RequestView; output: OutputView }) {
  const question = openQuestion(messagesFor(view, output.id), output.id);
  const text: Record<string, { title: string; body: string }> = {
    NEW: { title: "Received", body: "Waiting to be picked up." },
    WORKING: { title: "Being worked on", body: "A change is being prepared on a copy of the layout." },
    IN_REVIEW: { title: "With an admin", body: "An admin is looking at it. Nothing prints differently until they approve a change." },
    NEEDS_CODE: {
      title: "Needs a small code change first",
      body: "This change needs a new value we can't print yet. It continues by itself once that is live.",
    },
    FAILED: { title: "Stuck", body: "Preparing the change ran into a problem; an admin will look at it." },
    APPROVED: { title: "Approved", body: "The change was approved." },
    PUBLISHED: {
      title: `Live${output.publishedLabel ? ` since ${output.publishedLabel}` : ""}`,
      body: "The documents it changes go back through review before they reach a supplier.",
    },
    REJECTED: { title: "Not changed", body: output.rejectReason ? `Reason: ${output.rejectReason}` : "An admin decided not to change this." },
  };
  if (output.status === "NEEDS_INFO") {
    return (
      <Panel tone="violet" icon={<CircleHelp className="h-4 w-4" aria-hidden />} title="We need an answer from you">
        {question && (
          <blockquote className="whitespace-pre-wrap rounded-md border-l-4 border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-950">
            {question.body}
          </blockquote>
        )}
        <p className="mt-2 text-xs text-zinc-500">Answer in the box next to the thread.</p>
      </Panel>
    );
  }
  const t = text[output.status] ?? { title: output.status, body: "" };
  return (
    <Panel tone={output.status === "PUBLISHED" ? "green" : "zinc"} icon={null} title={t.title}>
      {t.body && <p className="whitespace-pre-wrap text-sm text-zinc-600">{t.body}</p>}
    </Panel>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

const PANEL_TONE = {
  zinc: "border-zinc-200 bg-white",
  blue: "border-blue-200 bg-blue-50/40",
  amber: "border-amber-200 bg-amber-50/40",
  violet: "border-violet-200 bg-violet-50/40",
  orange: "border-orange-200 bg-orange-50/40",
  red: "border-red-200 bg-red-50/40",
  green: "border-emerald-200 bg-emerald-50/40",
} as const;

export function Panel({
  tone,
  icon,
  title,
  children,
}: {
  tone: keyof typeof PANEL_TONE;
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <section className={`rounded-lg border p-4 ${PANEL_TONE[tone]}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        {icon}
        {title}
      </h2>
      {children && <div className="mt-2">{children}</div>}
    </section>
  );
}

function RunButton({
  requestId,
  outputId,
  label,
  again = false,
  onChanged,
}: {
  requestId: string;
  outputId: string;
  label: string;
  // A restart (the retry icon) rather than a first start.
  again?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    const res = await sendJson<{ started?: string[]; skipped?: { reason: string }[] }>(
      `/api/admin/change-requests/${requestId}/run`,
      "POST",
      { outputId },
    );
    setBusy(false);
    if (!res.ok) return setError(errorOf(res.data));
    if (!res.data.started?.length) return setError(res.data.skipped?.[0]?.reason ?? "The agent did not start");
    onChanged();
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        ) : again ? (
          <RotateCcw className="h-4 w-4" aria-hidden />
        ) : (
          <Play className="h-4 w-4" aria-hidden />
        )}
        {label}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

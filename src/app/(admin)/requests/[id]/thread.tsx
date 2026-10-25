"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Brain, Check, CircleHelp, Info, LoaderCircle, Send, X } from "lucide-react";
import type { MemoryCard, MessageView, OutputView, RequestView } from "@/lib/change-requests/review-view";
import { errorOf, messagesFor, sendJson } from "./shared";

// The review thread for one output (plus request-wide notes): the agent's
// summaries and questions, people's comments, system notes, and memory
// suggestions as "Remember for next time?" cards an admin keeps or dismisses
// (PATCH /api/admin/agent-memory/[id]).
//
// The composer posts to …/messages. An admin's comment on an output in review
// starts the agent on a new draft; an answer to a question restarts it. The
// filing reviewer only gets a composer while the agent waits on their answer.

export function Thread({ view, output, onChanged }: { view: RequestView; output: OutputView; onChanged: () => void }) {
  const messages = messagesFor(view, output.id);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  const canPost = view.admin || output.status === "NEEDS_INFO";

  return (
    <section className="flex max-h-[80vh] flex-col rounded-xl border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Thread</h2>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">Nothing here yet.</p>
        ) : (
          messages.map((m) => <Message key={m.id} m={m} admin={view.admin} onChanged={onChanged} />)
        )}
        <div ref={endRef} />
      </div>
      {canPost && <Composer view={view} output={output} onChanged={onChanged} />}
    </section>
  );
}

function Message({ m, admin, onChanged }: { m: MessageView; admin: boolean; onChanged: () => void }) {
  if (m.kind === "memory_suggestion") return <MemorySuggestion m={m} admin={admin} onChanged={onChanged} />;
  if (m.authorKind === "SYSTEM") {
    return (
      <div className="flex gap-2 text-xs text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div>
          <p className="whitespace-pre-wrap">{m.body}</p>
          <p className="mt-0.5 text-[11px] text-faint">{m.createdLabel}</p>
        </div>
      </div>
    );
  }
  const question = m.kind === "question";
  const agent = m.authorKind === "AGENT";
  return (
    <div
      data-private
      className={`rounded-md px-3 py-2 text-sm ${
        question
          ? "border border-transparent bg-warn-soft text-warn"
          : agent
            ? "border border-line bg-surface text-ink"
            : "ml-6 bg-subtle text-ink"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
        {question ? (
          <CircleHelp className="h-3.5 w-3.5 text-warn" aria-hidden />
        ) : agent ? (
          <Bot className="h-3.5 w-3.5" aria-hidden />
        ) : null}
        <span className="font-medium text-ink">{question ? `${m.author} asks` : m.author}</span>
        <span>· {m.createdLabel}</span>
      </div>
      <p className="whitespace-pre-wrap">{m.body}</p>
    </div>
  );
}

function MemorySuggestion({ m, admin, onChanged }: { m: MessageView; admin: boolean; onChanged: () => void }) {
  const [memory, setMemory] = useState<MemoryCard | null>(m.memory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (state: "KEPT" | "DISMISSED") => {
    if (!memory) return;
    setBusy(true);
    setError(null);
    const res = await sendJson<{ memory?: MemoryCard }>(`/api/admin/agent-memory/${memory.id}`, "PATCH", { state });
    setBusy(false);
    if (!res.ok) return setError(errorOf(res.data));
    setMemory({ ...memory, state: res.data.memory?.state ?? state });
    onChanged();
  };

  const state = memory?.state ?? null;
  return (
    <div className="rounded-md border border-transparent bg-accent-soft px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-accent-text">
        <Brain className="h-3.5 w-3.5" aria-hidden />
        Remember for next time?
      </div>
      <p className="whitespace-pre-wrap text-accent-text">{memory?.text ?? m.body}</p>
      {!memory ? (
        <p className="mt-1 text-[11px] text-accent-text">This note can&apos;t be found any more.</p>
      ) : state === "PROPOSED" && admin ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => decide("KEPT")}
            disabled={busy}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
            Keep
          </button>
          <button
            type="button"
            onClick={() => decide("DISMISSED")}
            disabled={busy}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Dismiss
          </button>
          {error && <span className="text-[11px] text-bad">{error}</span>}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-accent-text">
          {state === "KEPT"
            ? "Kept — the agent reads this on its next runs."
            : state === "DISMISSED"
              ? "Dismissed."
              : state === "FORGOTTEN"
                ? "Forgotten."
                : "Suggested."}{" "}
          <a href="/settings/agent-memory" className="underline">
            Manage notes
          </a>
        </p>
      )}
    </div>
  );
}

function Composer({ view, output, onChanged }: { view: RequestView; output: OutputView; onChanged: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const answering = output.status === "NEEDS_INFO" || (output.status === "IN_REVIEW" && !output.currentRevisionId);
  const revising = view.admin && output.status === "IN_REVIEW" && Boolean(output.currentRevisionId);
  // In review without a draft the agent either asked something or answered;
  // only a question gets "Answer the question".
  const lastAgent = [...view.messages].reverse().find((m) => m.outputId === output.id && m.authorKind === "AGENT");
  const asked = output.status === "NEEDS_INFO" || lastAgent?.kind === "question";
  const placeholder = answering
    ? asked
      ? "Answer the question…"
      : "Reply to the agent…"
    : revising
      ? "Ask for changes to this draft…"
      : "Add a note to the thread…";
  const hint = answering
    ? "Your answer goes to the agent, which continues with it."
    : revising
      ? "The agent makes a new draft from your comment."
      : null;

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await sendJson<{ started?: boolean }>(`/api/admin/change-requests/${view.id}/messages`, "POST", {
      outputId: output.id,
      body: text,
    });
    setBusy(false);
    if (!res.ok) return setError(errorOf(res.data));
    setBody("");
    setNote(res.data.started ? "Sent — the agent is on it." : "Sent.");
    onChanged();
  };

  return (
    <div className="border-t border-line p-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, 5000))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
        disabled={busy}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted">{error ? <span className="text-bad">{error}</span> : (note ?? hint)}</span>
        <button
          type="button"
          onClick={send}
          disabled={busy || !body.trim()}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          Send
        </button>
      </div>
    </div>
  );
}

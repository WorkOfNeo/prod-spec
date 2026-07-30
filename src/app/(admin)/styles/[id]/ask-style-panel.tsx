"use client";

import { useState } from "react";
import type { ExplainPointer, StyleExplainAnswer } from "@/lib/styles/explain-ai";

// =====================================================
// "Ask about this style" — the free-text way in.
//
// The page already SHOWS the facts (readiness ladder, PO scrape, size
// coverage, lookalike rows, supplier-folder diff). This panel is deliberately
// not another rendering of them: it answers the question a reviewer would
// otherwise put in a Slack message, over exactly the same evidence.
//
// Two things it must never do:
//   • Render a link the model made up. It doesn't get the chance — the answer
//     carries pointer IDs resolved server-side against hrefs we built.
//   • Dress a non-answer up as a diagnosis. `insufficient` is rendered as
//     plainly as a real answer, because "I can't see it from here" is the
//     honest outcome when the evidence doesn't cover the question.
// =====================================================

// The questions people actually ask, phrased the way they ask them. One tap
// beats a blank box — and each maps onto a part of the bundle that genuinely
// answers it (lookalikes + coverage, readiness ladder, folder diff).
const SUGGESTIONS = [
  "Why are sizes missing?",
  "Why hasn't this generated?",
  "Did the files reach the supplier?",
  "Am I looking at the right row?",
];

type AskState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; answer: StyleExplainAnswer }
  // `soft` marks the AI being unavailable/misbehaving rather than the reviewer
  // doing anything wrong — worth saying differently, since the facts on the
  // rest of the page are still perfectly good.
  | { kind: "error"; message: string; soft: boolean };

export function AskStylePanel({ styleId, className = "mt-8" }: { styleId: string; className?: string }) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<AskState>({ kind: "idle" });

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    setState({ kind: "asking" });
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        answer?: StyleExplainAnswer;
        error?: string;
      };
      if (!res.ok || !json.answer) {
        setState({
          kind: "error",
          message: json.error ?? `Couldn't get an answer (HTTP ${res.status}).`,
          // 503 = key not configured, 502 = model misbehaved. Neither is the
          // reviewer's problem.
          soft: res.status === 503 || res.status === 502,
        });
        return;
      }
      setState({ kind: "answered", answer: json.answer });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Request failed",
        soft: false,
      });
    }
  }

  const busy = state.kind === "asking";

  return (
    <section className={className}>
      <h2 className="text-sm font-semibold text-zinc-900">Ask about this style</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Answered only from this style&apos;s own data — its Monday fields, PO scrape, outputs and
        supplier folder. If the answer isn&apos;t in there, it says so rather than guessing.
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. why does this only have two sizes?"
          disabled={busy}
          className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none disabled:bg-zinc-50"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => void ask(s)}
            className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      {state.kind === "answered" && <Answer answer={state.answer} />}

      {state.kind === "error" && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${
            state.soft
              ? "border-zinc-200 bg-zinc-50 text-zinc-600"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {state.message}
          {state.soft && (
            <span className="mt-1 block text-xs text-zinc-500">
              Everything else on this page is still accurate — the panels above are read straight
              from the style&apos;s data, not from the AI.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Answer({ answer }: { answer: StyleExplainAnswer }) {
  return (
    <div
      className={`mt-3 rounded-md border px-3 py-2.5 ${
        answer.insufficient ? "border-zinc-200 bg-zinc-50" : "border-sky-200 bg-sky-50"
      }`}
    >
      {answer.likelyCause && !answer.insufficient && (
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
          {answer.likelyCause}
        </p>
      )}
      <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-line text-zinc-800">
        {answer.answer}
      </p>

      {answer.pointers.length > 0 && (
        <div className="mt-2.5 border-t border-sky-200/70 pt-2">
          <p className="text-[11px] font-medium text-zinc-500">Where to look</p>
          <ul className="mt-1 space-y-0.5">
            {answer.pointers.map((p) => (
              <li key={p.id} className="text-xs">
                <PointerLink pointer={p} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// A pointer without an href still carries useful direction (e.g. the Monday
// board id is missing, so we can't link it) — render the label rather than a
// dead link.
function PointerLink({ pointer }: { pointer: ExplainPointer }) {
  if (!pointer.href) return <span className="text-zinc-600">{pointer.label}</span>;
  const external = pointer.href.startsWith("http");
  return (
    <a
      href={pointer.href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="text-sky-800 underline decoration-sky-300 underline-offset-2 hover:decoration-sky-600"
    >
      {pointer.label}
      {external && <span aria-hidden> ↗</span>}
    </a>
  );
}

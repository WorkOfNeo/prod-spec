"use client";

import type { StepView } from "@/lib/change-requests/review-view";
import { count, usd } from "./shared";

// The agent's run log for one output (ADMIN): every step it took — tool
// calls, model turns with tokens and cost — as an audit trail, with the total
// cost. LiveSteps is the short tail shown while a run is in progress.

export function RunLog({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) return null;
  const total = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  return (
    <details className="rounded-lg border border-zinc-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800">
        Run log · {steps.length} step{steps.length === 1 ? "" : "s"} · {usd(total)}
      </summary>
      <div className="overflow-x-auto border-t border-zinc-100">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-1.5 font-medium">Time</th>
              <th className="px-3 py-1.5 font-medium">Step</th>
              <th className="px-3 py-1.5 font-medium">What happened</th>
              <th className="px-3 py-1.5 font-medium">Model</th>
              <th className="px-3 py-1.5 text-right font-medium">Tokens in / out</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.id} className={`border-t border-zinc-100 align-top ${s.kind === "error" ? "bg-red-50/50" : ""}`}>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-zinc-500">{s.timeLabel}</td>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-zinc-600">{s.kind}</td>
                <td className="px-3 py-1.5 text-zinc-800">{s.summary}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-zinc-500">{s.model ?? ""}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-zinc-600">
                  {s.inputTokens != null || s.outputTokens != null ? `${count(s.inputTokens)} / ${count(s.outputTokens)}` : ""}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-zinc-600">
                  {s.costUsd != null ? usd(s.costUsd) : ""}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-200 bg-zinc-50">
              <td colSpan={5} className="px-3 py-1.5 text-right font-medium text-zinc-600">
                Total
              </td>
              <td className="px-3 py-1.5 text-right font-medium tabular-nums text-zinc-900">{usd(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  );
}

const LIVE_TAIL = 8;

export function LiveSteps({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) return <p className="mt-2 text-xs text-zinc-500">Starting…</p>;
  const tail = steps.slice(-LIVE_TAIL);
  return (
    <ol className="mt-3 space-y-1 border-l-2 border-blue-200 pl-3 text-xs">
      {steps.length > tail.length && <li className="text-zinc-400">… {steps.length - tail.length} earlier steps</li>}
      {tail.map((s) => (
        <li key={s.id} className="flex gap-2">
          <span className="shrink-0 font-mono text-zinc-400">{s.timeLabel}</span>
          <span className="text-zinc-700">{s.summary}</span>
        </li>
      ))}
    </ol>
  );
}

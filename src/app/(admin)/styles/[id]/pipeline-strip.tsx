"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, X } from "lucide-react";

// The style's journey in one row: Monday → PO & barcodes → prod spec → fields
// → generated → review → supplier folder, each with where it stands. The
// step that's waiting on someone is underlined. Clicking the strip opens the
// full readiness ladder underneath — the same diagnostic, with the links that
// fix each step.

export type PipelineStepState = "done" | "warn" | "bad" | "current" | "todo";

export type PipelineStep = {
  key: string;
  label: string;
  detail: string;
  state: PipelineStepState;
};

function Marker({ state, index }: { state: PipelineStepState; index: number }) {
  if (state === "done") {
    return (
      <span className="bg-good-soft text-good inline-flex size-5 shrink-0 items-center justify-center rounded-full">
        <Check size={12} strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  if (state === "warn") {
    return (
      <span className="text-warn inline-flex size-5 shrink-0 items-center justify-center">
        <AlertTriangle size={15} aria-hidden="true" />
      </span>
    );
  }
  if (state === "bad") {
    return (
      <span className="bg-bad-soft text-bad inline-flex size-5 shrink-0 items-center justify-center rounded-full">
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums ${
        state === "current" ? "bg-accent-soft text-accent-text" : "bg-subtle text-muted"
      }`}
    >
      {index + 1}
    </span>
  );
}

const STATE_LABEL: Record<PipelineStepState, string> = {
  done: "done",
  warn: "needs attention",
  bad: "blocked",
  current: "waiting",
  todo: "not yet",
};

export function PipelineStrip({ steps, children }: { steps: PipelineStep[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section data-section="Pipeline" aria-label="Pipeline" className="border-line bg-surface overflow-hidden rounded-xl border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? "Hide the details" : "Show what each step needs"}
        className="hover:bg-subtle/60 flex w-full overflow-x-auto text-left transition-colors duration-150"
      >
        {steps.map((s, i) => (
          <span
            key={s.key}
            className={`border-line relative flex min-w-[9.5rem] flex-1 items-start gap-2.5 px-4 py-3 ${
              i > 0 ? "border-l" : ""
            }`}
          >
            <Marker state={s.state} index={i} />
            <span className="min-w-0">
              <span className="text-ink block text-[13px] leading-5 font-medium">{s.label}</span>
              <span className="text-muted block truncate text-[12px]" title={s.detail}>
                {s.detail}
              </span>
              <span className="sr-only">, {STATE_LABEL[s.state]}</span>
            </span>
            {s.state === "current" ? (
              <span aria-hidden="true" className="bg-accent absolute inset-x-0 bottom-0 h-0.5" />
            ) : null}
          </span>
        ))}
        <span className="border-line text-faint flex shrink-0 items-center border-l px-3">
          <ChevronDown size={15} aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open ? <div className="border-line reveal border-t p-3">{children}</div> : null}
    </section>
  );
}

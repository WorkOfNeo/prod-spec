"use client";

import { useState, type ReactNode } from "react";

// Collapsible "Outputs · X of Y ready" section, closed by default so a style
// with many outputs stays scannable. Collapsed, it surfaces the missing
// fields at the top so you still see what's blocking generation without
// expanding; the per-output rows (children) render only once opened.
export function OutputsAccordion({
  readyCount,
  total,
  missingFieldLabels,
  children,
}: {
  readyCount: number;
  total: number;
  // Deduped labels of the fields blocking any not-ready output.
  missingFieldLabels: string[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasMissing = missingFieldLabels.length > 0;
  const shown = missingFieldLabels.slice(0, 8);
  const extra = missingFieldLabels.length - shown.length;

  return (
    <section className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left"
      >
        <Chevron open={open} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-700">
              Outputs · {readyCount} of {total} ready
            </h2>
            {!open && !hasMissing && (
              <span className="text-xs text-zinc-400">all outputs have their fields</span>
            )}
          </div>
          {/* Collapsed: the missing fields at the top, so blockers are visible
              at a glance. Expanded, the per-output rows carry the same detail. */}
          {!open && hasMissing && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium text-zinc-500">Missing fields:</span>
              {shown.map((l) => (
                <span
                  key={l}
                  className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                >
                  {l}
                </span>
              ))}
              {extra > 0 && <span className="text-[11px] text-zinc-400">+{extra} more</span>}
            </div>
          )}
        </div>
      </button>

      {open && (
        <>
          <p className="mt-1 pl-5 text-xs text-zinc-400">
            Live previews render from the row&apos;s current data — run each output on its own as it
            goes ready.
          </p>
          <div className="mt-2 flex flex-col gap-2">{children}</div>
        </>
      )}
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${
        open ? "rotate-90" : ""
      }`}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  DocTypesManager,
  type ManagedDocType,
  type ExclusionFieldOption,
} from "./doc-types-manager";

// "Document types" button + modal — sits next to "New layout" in the Output
// Builder header. Opens the doc-type catalogue + keyword-exclusion-rule editor
// (moved here from the old bottom-of-page card). Modal chrome mirrors
// EmailSimulationDialog: backdrop click + Escape close, inner panel stops
// propagation, max-height scroll.
export function DocTypesButton({
  initialTypes,
  fields,
  defaultOpen = false,
}: {
  initialTypes: ManagedDocType[];
  fields: ExclusionFieldOption[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        Document types
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgb(15_17_21/0.40)] p-4 py-10"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Document types"
        >
          <div
            className="flex w-full max-w-2xl flex-col rounded-xl bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Document types</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-sm text-faint hover:bg-subtle hover:text-ink"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="px-5 py-4">
              <DocTypesManager initialTypes={initialTypes} fields={fields} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

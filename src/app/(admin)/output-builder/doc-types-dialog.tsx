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
        className="rounded-md border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50"
      >
        Document types
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Document types"
        >
          <div
            className="flex w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-900">Document types</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
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

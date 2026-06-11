import type { ReactNode } from "react";
import { docTypeLabel } from "@/lib/pdf/doc-types";

// Group items by docType, preserving the order each type first appears
// (callers pass already-sorted assets, so the bundle framing stays first).
export function groupByDocType<T extends { docType: string }>(
  items: T[],
): Array<{ docType: string; label: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const arr = map.get(item.docType);
    if (arr) arr.push(item);
    else map.set(item.docType, [item]);
  }
  return [...map.entries()].map(([docType, items]) => ({ docType, label: docTypeLabel(docType), items }));
}

// One collapsible group, grouped per document type. Native <details> so it
// works in a server component (open/close with no client JS). Default open.
export function DocTypeAccordion({
  label,
  count,
  rightHint,
  defaultOpen = true,
  children,
}: {
  label: string;
  count: number;
  rightHint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-zinc-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 select-none hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5 text-zinc-400 transition-transform group-open:rotate-90"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="text-sm font-semibold text-zinc-800">{label}</span>
          <span className="text-xs font-normal text-zinc-400">({count})</span>
        </span>
        {rightHint ? <span className="text-xs text-zinc-500">{rightHint}</span> : null}
      </summary>
      <div className="border-t border-zinc-100 p-4">{children}</div>
    </details>
  );
}

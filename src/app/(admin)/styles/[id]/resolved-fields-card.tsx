"use client";

import { useState, type ReactNode } from "react";
import { Search } from "lucide-react";

// What the PDFs print, resolved from the column mapping — a two-column grid
// with a filter, so one field is a keystroke away among the thirty-odd.

export type ResolvedFieldRow = {
  key: string;
  label: string;
  // Plain text of the value, for the filter.
  text: string;
  value: ReactNode;
  required: boolean;
  missing: boolean;
};

export function ResolvedFieldsCard({ rows, description }: { rows: ResolvedFieldRow[]; description: string }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) => r.label.toLowerCase().includes(needle) || r.text.toLowerCase().includes(needle))
    : rows;
  return (
    <section data-section="Resolved fields" className="border-line bg-surface overflow-hidden rounded-xl border">
      <div className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-ink text-[14px] font-semibold">Resolved fields</h2>
          <p className="text-muted text-[12px]">{description}</p>
        </div>
        <label className="relative">
          <span className="sr-only">Filter fields</span>
          <Search size={13} aria-hidden="true" className="text-faint pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter fields"
            className="border-line bg-surface text-ink placeholder:text-faint focus:border-accent h-7 w-44 rounded-md border pr-2 pl-7 text-[12px] outline-none"
          />
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted px-4 py-6 text-center text-[13px]">No field matches &ldquo;{q}&rdquo;.</p>
      ) : (
        <dl className="grid grid-cols-1 sm:grid-cols-2">
          {shown.map((r, i) => (
            <div
              key={r.key}
              className={`border-line flex gap-3 border-t px-4 py-2.5 ${i < 2 ? "sm:border-t-0" : ""} ${i === 0 ? "border-t-0" : ""} ${
                i % 2 === 0 ? "sm:border-r" : ""
              } ${r.missing ? "bg-warn-soft" : ""}`}
            >
              <dt className="w-36 shrink-0">
                <span className="text-muted block text-[12px] leading-5">{r.label}</span>
                {r.required ? (
                  <span
                    title="Required: needed by one of this style's outputs"
                    className={`mt-1 inline-block rounded px-1.5 text-[11px] ${r.missing ? "bg-warn-soft text-warn" : "bg-subtle text-muted"}`}
                  >
                    Required
                  </span>
                ) : null}
              </dt>
              <dd className={`min-w-0 flex-1 text-[13px] break-words ${r.missing ? "text-warn" : r.text ? "text-ink" : "text-faint"}`}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

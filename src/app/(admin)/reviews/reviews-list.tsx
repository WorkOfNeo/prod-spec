"use client";

// Read-only catalogue of every generated output (T8). Newest first, with a
// client-side filter over the visible columns so a long history stays
// navigable. Pure presentation — no mutations: the row actions are a link to
// the PDF (the existing preview route) and a link to the owning style.

import Link from "next/link";
import { useState } from "react";

export type ReviewRow = {
  id: string;
  outputType: string;
  outputName: string;
  styleId: string;
  styleName: string;
  customerName: string;
  businessArea: string | null;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  openHref: string;
  createdAgo: string;
};

const STATUS_STYLE: Record<ReviewRow["reviewStatus"], { label: string; cls: string }> = {
  PENDING_REVIEW: { label: "Pending", cls: "bg-zinc-100 text-zinc-600" },
  APPROVED: { label: "Approved", cls: "bg-emerald-50 text-emerald-700" },
  REJECTED: { label: "Rejected", cls: "bg-red-50 text-red-700" },
};

export function ReviewsList({ rows, truncated }: { rows: ReviewRow[]; truncated: boolean }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((r) =>
        [r.outputType, r.outputName, r.styleName, r.customerName, r.businessArea ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : rows;

  return (
    <div className="px-8 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
          <p className="text-sm text-zinc-500">
            Every generated output, newest first. Open a document to inspect the PDF, or click a
            style to open its page.
          </p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by output, style, customer…"
          className="w-72 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-zinc-400 focus:outline-none"
        />
      </div>

      <p className="mt-4 text-xs text-zinc-500">
        {filtered.length} {filtered.length === 1 ? "output" : "outputs"}
        {needle ? <> matching &ldquo;{q.trim()}&rdquo;</> : null}
        {truncated ? <> · showing the most recent {rows.length}</> : null}
      </p>

      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-8 text-center">
          <div className="text-sm font-semibold text-zinc-800">No outputs yet.</div>
          <p className="mt-1 text-sm text-zinc-500">
            Generated documents will appear here once a job produces output PDFs.
          </p>
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2 font-semibold">Output type</th>
                <th className="px-4 py-2 font-semibold">Output name</th>
                <th className="px-4 py-2 font-semibold">Style</th>
                <th className="px-4 py-2 font-semibold">Customer</th>
                <th className="px-4 py-2 font-semibold">Business area</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Generated</th>
                <th className="px-4 py-2 text-right font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const status = STATUS_STYLE[r.reviewStatus];
                return (
                  <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50/60">
                    <td className="px-4 py-2 text-zinc-600">{r.outputType}</td>
                    <td className="px-4 py-2 font-medium text-zinc-900">{r.outputName}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/styles/${r.styleId}`}
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {r.styleName}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-zinc-600">{r.customerName}</td>
                    <td className="px-4 py-2 text-zinc-600">{r.businessArea ?? "—"}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${status.cls}`}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">{r.createdAgo}</td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={r.openHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Open output
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

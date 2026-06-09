"use client";

// Single-input filtered table for /prod-specs. Receives the full row
// set from the server component once; filters in-browser. With ~75 rows
// today (and growing slowly), client-side filtering is instant.

import Link from "next/link";
import { useMemo, useState } from "react";

export type ProdSpecRow = {
  id: string;
  name: string;
  customerName: string;
  businessAreaName: string;
  businessAreaMondayValue: string;
  supplierCount: number;
  styleCount: number;
  jobCount: number;
  autoGenerateThresholdPct: number;
  active: boolean;
  updatedAt: string;
  // Pre-built lower-case search blob so filtering is one substring check
  // per row regardless of how many fields we include in the search.
  searchBlob: string;
};

export function ProdSpecsTable({ rows }: { rows: ProdSpecRow[] }) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.searchBlob.includes(needle));
  }, [rows, q]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, customer, or business area…"
            className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <span className="text-xs tabular-nums text-zinc-500">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Business area</th>
              <th className="px-4 py-3">Suppliers</th>
              <th className="px-4 py-3">Styles</th>
              <th
                className="px-4 py-3"
                title="Generation jobs tied to this prod spec (analytics)."
              >
                Jobs
              </th>
              <th className="px-4 py-3">Threshold</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-zinc-500">
                  {rows.length === 0
                    ? "No prod specs yet. They auto-create when the first Style ingests with a known customer × business area pair."
                    : "No prod specs match the current search."}
                </td>
              </tr>
            ) : (
              filtered.map((ps) => (
                <tr
                  key={ps.id}
                  className={`border-t border-zinc-100 hover:bg-zinc-50 ${
                    ps.active ? "" : "opacity-50"
                  }`}
                >
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/prod-specs/${ps.id}`} className="hover:underline">
                      {ps.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{ps.customerName}</td>
                  <td className="px-4 py-3 text-zinc-600">{ps.businessAreaName}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">
                    {ps.supplierCount}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{ps.styleCount}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{ps.jobCount}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">
                    {ps.autoGenerateThresholdPct}%
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {ps.active ? "yes" : "no"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{ps.updatedAt}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

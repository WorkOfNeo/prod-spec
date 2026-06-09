"use client";

// Matrix of prod specs × languages. Each cell toggles whether that prod
// spec's outputs render in that language. Saves per row via PATCH
// /api/admin/prod-specs/{id} (sending the full `outputLanguages` array).
// Toggling languages here never auto-activates a prod spec — the PATCH
// route deliberately keeps `outputLanguages` out of its `hasOtherChange`.

import { useMemo, useRef, useState } from "react";
import { Toggle } from "@/components/toggle";

type LanguageCol = { code: string; name: string };

export type MatrixRow = {
  id: string;
  name: string;
  customerName: string;
  businessAreaName: string;
  outputLanguages: string[];
};

type RowStatus = "idle" | "saving" | "saved" | "error";

export function ProdSpecLanguageMatrix({
  rows,
  languages,
}: {
  rows: MatrixRow[];
  languages: LanguageCol[];
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.outputLanguages])),
  );
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  // Per-row save sequence so a slow earlier response can't clobber the
  // status of a newer one.
  const seqRef = useRef<Record<string, number>>({});

  const activeCodes = useMemo(() => languages.map((l) => l.code), [languages]);

  // Order a set of codes by the /languages sortOrder (the `languages` prop
  // order); append any selected code no longer active so it isn't dropped.
  function orderCodes(codes: Iterable<string>): string[] {
    const set = new Set(codes);
    const inOrder = activeCodes.filter((c) => set.has(c));
    const extras = Array.from(set).filter((c) => !activeCodes.includes(c));
    return [...inOrder, ...extras];
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      `${r.name} ${r.customerName} ${r.businessAreaName}`.toLowerCase().includes(needle),
    );
  }, [rows, q]);

  async function save(id: string, codes: string[]) {
    const seq = (seqRef.current[id] ?? 0) + 1;
    seqRef.current[id] = seq;
    setStatus((s) => ({ ...s, [id]: "saving" }));
    try {
      const res = await fetch(`/api/admin/prod-specs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputLanguages: codes }),
      });
      if (seqRef.current[id] !== seq) return; // superseded by a newer save
      setStatus((s) => ({ ...s, [id]: res.ok ? "saved" : "error" }));
    } catch {
      if (seqRef.current[id] !== seq) return;
      setStatus((s) => ({ ...s, [id]: "error" }));
    }
  }

  function setRow(id: string, codes: Iterable<string>) {
    const ordered = orderCodes(codes);
    setSelected((prev) => ({ ...prev, [id]: ordered }));
    void save(id, ordered);
  }

  function toggleCell(id: string, code: string, next: boolean) {
    const cur = new Set(selected[id] ?? []);
    if (next) cur.add(code);
    else cur.delete(code);
    setRow(id, cur);
  }

  // Column header toggle: if every filtered row already has the code, clear
  // it across them; otherwise set it on all of them.
  function toggleColumn(code: string) {
    const allHave = filtered.every((r) => (selected[r.id] ?? []).includes(code));
    for (const r of filtered) {
      const cur = new Set(selected[r.id] ?? []);
      if (allHave) cur.delete(code);
      else cur.add(code);
      setRow(r.id, cur);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter prod specs by name, customer, or business area…"
          className="w-full max-w-md rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        />
        <span className="text-xs tabular-nums text-zinc-500">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="overflow-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="sticky left-0 z-10 bg-zinc-50 px-4 py-3 text-left font-medium">
                Prod spec
              </th>
              {languages.map((l) => (
                <th key={l.code} className="px-2 py-3 text-center font-medium">
                  <button
                    type="button"
                    onClick={() => toggleColumn(l.code)}
                    title={`${l.name} — toggle for all shown rows`}
                    className="mx-auto block rounded px-1.5 py-0.5 uppercase hover:bg-zinc-200"
                  >
                    {l.code}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={languages.length + 1}
                  className="px-4 py-12 text-center text-zinc-500"
                >
                  {rows.length === 0
                    ? "No prod specs yet."
                    : "No prod specs match the current filter."}
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const codes = new Set(selected[r.id] ?? []);
                return (
                  <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50/60">
                    <td className="sticky left-0 z-10 bg-white px-4 py-2 align-top">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] text-zinc-500">
                        {r.customerName} · {r.businessAreaName}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setRow(r.id, activeCodes)}
                          className="text-zinc-500 underline hover:text-zinc-800"
                        >
                          all
                        </button>
                        <button
                          type="button"
                          onClick={() => setRow(r.id, [])}
                          className="text-zinc-500 underline hover:text-zinc-800"
                        >
                          none
                        </button>
                        <StatusDot status={status[r.id] ?? "idle"} />
                      </div>
                    </td>
                    {languages.map((l) => (
                      <td key={l.code} className="px-2 py-2 text-center">
                        <Toggle
                          checked={codes.has(l.code)}
                          onChange={(next) => toggleCell(r.id, l.code, next)}
                          ariaLabel={`${r.name} · ${l.name}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: RowStatus }) {
  if (status === "idle") return null;
  const map: Record<Exclude<RowStatus, "idle">, { color: string; label: string }> = {
    saving: { color: "bg-amber-400 animate-pulse", label: "Saving…" },
    saved: { color: "bg-emerald-500", label: "Saved" },
    error: { color: "bg-red-500", label: "Error — retry" },
  };
  const { color, label } = map[status];
  return (
    <span className="inline-flex items-center gap-1 text-zinc-500">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { EanView } from "@/lib/po/ean-view";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import { colorFromVariantLabel } from "@/lib/po/ean-format";

export type PoEanRow = {
  id: string;
  name: string;
  poNumber: string;
  supplierName: string | null;
  // Formatted timestamp of the last resolution attempt (null = never).
  resolvedAt: string | null;
  // Persisted resolution snapshot rendered on first paint.
  initial: EanView;
};

function StatusBadge({ status }: { status: string }) {
  const m = eanStatusMeta(status);
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function PoEansTable({
  rows,
  counts,
}: {
  rows: PoEanRow[];
  counts: Record<string, number>;
}) {
  const [q, setQ] = useState("");
  // Per-row override after a manual re-resolve ("loading" while in flight).
  const [overrides, setOverrides] = useState<Record<string, EanView | "loading">>({});
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((r) =>
      `${r.name} ${r.poNumber} ${r.supplierName ?? ""}`.toLowerCase().includes(n),
    );
  }, [rows, q]);

  async function resolve(id: string) {
    setOverrides((p) => ({ ...p, [id]: "loading" }));
    try {
      const res = await fetch(`/api/admin/styles/${id}/eans`);
      const data = (await res.json()) as EanView;
      setOverrides((p) => ({ ...p, [id]: data }));
    } catch (e) {
      setOverrides((p) => ({
        ...p,
        [id]: {
          status: "ERROR",
          message: e instanceof Error ? e.message : "failed",
          poFileName: null,
          sizeEans: [],
          cartonEan: null,
        },
      }));
    }
  }

  async function resolveAll() {
    setBusy(true);
    // Each resolve is a PDF download + parse, so cap the batch and run a few
    // in parallel. Drive-wide search means a folder link isn't required.
    const targets = filtered.slice(0, 20).map((r) => r.id);
    let i = 0;
    const worker = async () => {
      while (i < targets.length) await resolve(targets[i++]);
    };
    await Promise.all([worker(), worker(), worker()]);
    setBusy(false);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search style, PO, or supplier…"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={resolveAll}
          disabled={busy}
          className="shrink-0 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {busy ? "Resolving…" : "Re-resolve first 20"}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([status, n]) => {
            const m = eanStatusMeta(status);
            return (
              <span
                key={status}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}
              >
                {m.label} <span className="tabular-nums opacity-70">{n}</span>
              </span>
            );
          })}
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Style</th>
              <th className="px-4 py-3">PO</th>
              <th className="px-4 py-3">Supplier</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">EANs (size order) + carton</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const ov = overrides[r.id];
              const loading = ov === "loading";
              const view = ov && ov !== "loading" ? ov : r.initial;
              return (
                <tr key={r.id} className="border-t border-zinc-100 align-top">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{r.poNumber}</td>
                  <td className="px-4 py-3 text-zinc-600">{r.supplierName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={loading ? "RESOLVING" : view.status} />
                    {!ov && r.resolvedAt && (
                      <div className="mt-0.5 text-[11px] text-zinc-400">{r.resolvedAt}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {loading ? (
                      <span className="text-zinc-400">Resolving…</span>
                    ) : (
                      <ResultCell view={view} />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => resolve(r.id)}
                      disabled={loading}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                    >
                      {loading ? "…" : "Re-resolve"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultCell({ view }: { view: EanView }) {
  return (
    <div>
      {view.poFileName && <div className="mb-1 text-xs text-zinc-400">{view.poFileName}</div>}
      {view.sizeEans.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {view.sizeEans.map((s, i) => {
            const color = colorFromVariantLabel(s.variantLabel);
            return (
              <li key={i} className="tabular-nums">
                <span className="text-zinc-500">{s.size}</span>
                {color && <span className="text-zinc-400"> · {color}</span>}{" "}
                <span className={s.ean13 ? "font-medium text-zinc-800" : "text-zinc-300"}>
                  {s.ean13 ?? "— no match"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {view.cartonEan && (
        <div className="mt-1 text-xs tabular-nums text-zinc-500">
          carton <span className="font-medium text-zinc-800">{view.cartonEan}</span>
        </div>
      )}
      {view.sizeEans.length === 0 && !view.message && (
        <span className="text-xs text-zinc-400">—</span>
      )}
      {view.message && <div className="mt-1 text-xs text-zinc-400">{view.message}</div>}
    </div>
  );
}

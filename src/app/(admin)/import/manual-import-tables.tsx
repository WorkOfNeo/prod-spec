"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { GhostItemImportCandidate } from "@/lib/import/scan";

type PromoteResponse = {
  promoted: number;
  alreadyExisted: number;
  jobsEnqueued: number;
  failures: Array<{ ghostItemId: string; error: string }>;
};

type Filter = {
  customerId: string;
  baId: string;
  board: string;
};

const FILTER_ANY = "__any__";

export function ManualImportTables({
  importable,
  ambiguous,
}: {
  importable: GhostItemImportCandidate[];
  ambiguous: GhostItemImportCandidate[];
}) {
  return (
    <>
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Manual import — Ready ({importable.length})
        </h2>
        <ReadyTable items={importable} />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Manual import — Needs disambiguation ({ambiguous.length})
        </h2>
        <DisambiguationTable items={ambiguous} />
      </section>
    </>
  );
}

// -----------------------------------------------------
// Ready table — unambiguous matches, simple bulk select.
// -----------------------------------------------------
function ReadyTable({ items }: { items: GhostItemImportCandidate[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>({
    customerId: FILTER_ANY,
    baId: FILTER_ANY,
    board: FILTER_ANY,
  });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);

  const customerOptions = useMemo(() => uniqueCustomers(items), [items]);
  const baOptions = useMemo(() => uniqueBas(items), [items]);
  const boardOptions = useMemo(() => uniqueBoards(items), [items]);

  const filtered = useMemo(
    () =>
      items.filter((it) => {
        if (filter.customerId !== FILTER_ANY) {
          if (it.customerResolution.kind !== "unique") return false;
          if (it.customerResolution.customerId !== filter.customerId) return false;
        }
        if (filter.baId !== FILTER_ANY) {
          if (it.baResolution.kind !== "resolved") return false;
          if (it.baResolution.businessAreaId !== filter.baId) return false;
        }
        if (filter.board !== FILTER_ANY && it.mondayBoardId !== filter.board) return false;
        return true;
      }),
    [items, filter],
  );

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((it) => selected.has(it.ghostItemId));

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const it of filtered) next.delete(it.ghostItemId);
      } else {
        for (const it of filtered) next.add(it.ghostItemId);
      }
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importSelected() {
    const chosen = filtered.filter((it) => selected.has(it.ghostItemId));
    if (chosen.length === 0) return;
    setBusy(true);
    setToast(null);
    try {
      const payload = chosen.map((it) => ({
        ghostItemId: it.ghostItemId,
        customerId:
          it.customerResolution.kind === "unique" ? it.customerResolution.customerId : "",
      }));
      const res = await fetch("/api/admin/import/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setToast({ kind: "err", message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as PromoteResponse;
      const parts = [
        `${body.promoted} imported`,
        `${body.jobsEnqueued} job${body.jobsEnqueued === 1 ? "" : "s"} queued`,
      ];
      if (body.alreadyExisted > 0) parts.push(`${body.alreadyExisted} already existed`);
      if (body.failures.length > 0) parts.push(`${body.failures.length} failed`);
      setToast({ kind: "ok", message: parts.join(" · ") });
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setToast({ kind: "err", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
        Nothing ready to import. Items appear here once their (customer × business area) pair
        has a ProdSpec.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {toast && (
        <div
          className={`border-b px-4 py-2 text-sm ${
            toast.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {toast.message}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 bg-zinc-50 px-4 py-3 text-sm">
        <FilterSelect
          label="Customer"
          value={filter.customerId}
          onChange={(v) => setFilter((f) => ({ ...f, customerId: v }))}
          options={customerOptions}
        />
        <FilterSelect
          label="Business area"
          value={filter.baId}
          onChange={(v) => setFilter((f) => ({ ...f, baId: v }))}
          options={baOptions}
        />
        <FilterSelect
          label="Board"
          value={filter.board}
          onChange={(v) => setFilter((f) => ({ ...f, board: v }))}
          options={boardOptions}
        />
        <span className="ml-auto text-xs tabular-nums text-zinc-500">
          Showing {filtered.length} of {items.length}
        </span>
      </div>

      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                aria-label="Toggle all visible"
              />
            </th>
            <th className="px-4 py-3">Item</th>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Business area</th>
            <th className="px-4 py-3">Board</th>
            <th className="px-4 py-3">PO#</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500">
                No matches for the current filters.
              </td>
            </tr>
          ) : (
            filtered.map((it) => {
              const customerName =
                it.customerResolution.kind === "unique"
                  ? it.customerResolution.customerName
                  : "—";
              const baName =
                it.baResolution.kind === "resolved" ? it.baResolution.baName : "—";
              return (
                <tr key={it.ghostItemId} className="border-t border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(it.ghostItemId)}
                      onChange={() => toggleOne(it.ghostItemId)}
                      aria-label={`Select ${it.itemName}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">{it.itemName}</td>
                  <td className="px-4 py-3 text-zinc-600">{customerName}</td>
                  <td className="px-4 py-3 text-zinc-600">{baName}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{it.boardLabel}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{it.poNumber ?? "—"}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50 px-4 py-3 text-sm">
        <span className="text-zinc-600">{selected.size} selected</span>
        <button
          type="button"
          onClick={importSelected}
          disabled={busy || selected.size === 0}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Importing…" : `Import ${selected.size} selected`}
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------
// Disambiguation table — ambiguous customer matches.
// Per-row dropdown of candidate customers must be filled before that row
// can participate in the bulk Import action.
// -----------------------------------------------------
function DisambiguationTable({ items }: { items: GhostItemImportCandidate[] }) {
  const router = useRouter();
  const [picks, setPicks] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);

  function setPick(ghostItemId: string, customerId: string) {
    setPicks((prev) => {
      const next = new Map(prev);
      if (!customerId) next.delete(ghostItemId);
      else next.set(ghostItemId, customerId);
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const importable = useMemo(
    () => Array.from(selected).filter((id) => picks.has(id)),
    [selected, picks],
  );

  async function importSelected() {
    if (importable.length === 0) return;
    setBusy(true);
    setToast(null);
    try {
      const payload = importable.map((id) => ({
        ghostItemId: id,
        customerId: picks.get(id)!,
      }));
      const res = await fetch("/api/admin/import/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setToast({ kind: "err", message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as PromoteResponse;
      const parts = [
        `${body.promoted} imported`,
        `${body.jobsEnqueued} job${body.jobsEnqueued === 1 ? "" : "s"} queued`,
      ];
      if (body.alreadyExisted > 0) parts.push(`${body.alreadyExisted} already existed`);
      if (body.failures.length > 0) parts.push(`${body.failures.length} failed`);
      setToast({ kind: "ok", message: parts.join(" · ") });
      setSelected(new Set());
      setPicks(new Map());
      router.refresh();
    } catch (err) {
      setToast({ kind: "err", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
        No ambiguous items. When a ghost item&apos;s name token matches several customers (e.g.
        JYSK A/S and JYSK SE), it surfaces here for the operator to pick the right one.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {toast && (
        <div
          className={`border-b px-4 py-2 text-sm ${
            toast.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {toast.message}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="w-10 px-4 py-3"></th>
            <th className="px-4 py-3">Item</th>
            <th className="px-4 py-3">Customer (pick one)</th>
            <th className="px-4 py-3">Business area</th>
            <th className="px-4 py-3">Board</th>
            <th className="px-4 py-3">PO#</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const candidates =
              it.customerResolution.kind === "ambiguous"
                ? it.customerResolution.candidates
                : [];
            const baName =
              it.baResolution.kind === "resolved" ? it.baResolution.baName : "—";
            const pick = picks.get(it.ghostItemId) ?? "";
            const isSelected = selected.has(it.ghostItemId);
            return (
              <tr key={it.ghostItemId} className="border-t border-zinc-100 hover:bg-zinc-50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(it.ghostItemId)}
                    aria-label={`Select ${it.itemName}`}
                  />
                </td>
                <td className="px-4 py-3 font-medium">{it.itemName}</td>
                <td className="px-4 py-3">
                  <select
                    value={pick}
                    onChange={(e) => setPick(it.ghostItemId, e.target.value)}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
                  >
                    <option value="">— pick customer —</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3 text-zinc-600">{baName}</td>
                <td className="px-4 py-3 text-xs text-zinc-500">{it.boardLabel}</td>
                <td className="px-4 py-3 text-xs text-zinc-500">{it.poNumber ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50 px-4 py-3 text-sm">
        <span className="text-zinc-600">
          {selected.size} selected · {importable.length} with customer picked
        </span>
        <button
          type="button"
          onClick={importSelected}
          disabled={busy || importable.length === 0}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          title={
            importable.length === 0
              ? "Pick a customer on each selected row before importing"
              : undefined
          }
        >
          {busy ? "Importing…" : `Import ${importable.length} selected`}
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-600">
      <span className="uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
      >
        <option value={FILTER_ANY}>Any</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function uniqueCustomers(items: GhostItemImportCandidate[]) {
  const m = new Map<string, string>();
  for (const it of items) {
    if (it.customerResolution.kind === "unique") {
      m.set(it.customerResolution.customerId, it.customerResolution.customerName);
    }
  }
  return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function uniqueBas(items: GhostItemImportCandidate[]) {
  const m = new Map<string, string>();
  for (const it of items) {
    if (it.baResolution.kind === "resolved") {
      m.set(it.baResolution.businessAreaId, it.baResolution.baName);
    }
  }
  return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function uniqueBoards(items: GhostItemImportCandidate[]) {
  const m = new Map<string, string>();
  for (const it of items) m.set(it.mondayBoardId, it.boardLabel);
  return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

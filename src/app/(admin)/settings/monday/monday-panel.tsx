"use client";

import { useState } from "react";

export type WebhookEventOption = {
  value: string;
  label: string;
  hint: string;
};

// Default subscription set. change_column_value is the broad catch-all that
// covers every synced column; the rest add create + status + lifecycle.
export const EVENT_OPTIONS: WebhookEventOption[] = [
  { value: "create_item", label: "create_item", hint: "New style added" },
  { value: "change_column_value", label: "change_column_value", hint: "Any column edited (catch-all)" },
  { value: "change_status_column_value", label: "change_status_column_value", hint: "Status column changed" },
  { value: "item_archived", label: "item_archived", hint: "Item archived (flagged, not deleted)" },
  { value: "item_deleted", label: "item_deleted", hint: "Item deleted (flagged, not deleted)" },
];

const DEFAULT_EVENTS = EVENT_OPTIONS.map((e) => e.value);

export type BoardSummary = {
  boardId: string;
  customers: string[];
  events: string[];
};

type Busy = null | "check" | "register" | "fill";

function Pill({ children, tone = "zinc" }: { children: React.ReactNode; tone?: "zinc" | "green" | "red" | "amber" }) {
  const tones: Record<string, string> = {
    zinc: "bg-zinc-100 text-zinc-700",
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-800",
  };
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function BoardCard({ board, isAdmin }: { board: BoardSummary; isAdmin: boolean }) {
  const [selected, setSelected] = useState<string[]>(DEFAULT_EVENTS);
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<{ kind: "check" | "register" | "fill"; data: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(value: string) {
    setSelected((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]));
  }

  async function run(kind: Busy, fn: () => Promise<Response>) {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const res = await fn();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ? `${data.error}${data.details ? ` — ${JSON.stringify(data.details)}` : ""}` : `HTTP ${res.status}`);
        return;
      }
      setResult({ kind: kind as "check" | "register" | "fill", data });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const check = () =>
    run("check", () => fetch(`/api/admin/monday/columns?boardId=${encodeURIComponent(board.boardId)}`));
  const register = () =>
    run("register", () =>
      fetch("/api/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: board.boardId, events: selected }),
      }),
    );
  const fill = () => {
    if (!confirm(`Backfill ALL items on board ${board.boardId} into the mirror? This is mirror-only — no jobs fire.`)) return Promise.resolve();
    return run("fill", () =>
      fetch("/api/admin/monday/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: board.boardId }),
      }),
    );
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-mono text-sm font-semibold">{board.boardId}</div>
          <div className="text-xs text-zinc-500">
            {board.customers.length ? board.customers.join(", ") : "no customer config"}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {board.events.length === 0 ? (
            <Pill tone="amber">no webhooks yet</Pill>
          ) : (
            board.events.map((e) => <Pill key={e} tone="green">{e}</Pill>)
          )}
        </div>
      </div>

      <fieldset className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2" disabled={!isAdmin || busy !== null}>
        {EVENT_OPTIONS.map((opt) => {
          const already = board.events.includes(opt.value);
          return (
            <label key={opt.value} className="flex items-start gap-2 text-xs text-zinc-700">
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                className="mt-0.5"
              />
              <span>
                <span className="font-mono">{opt.label}</span>
                {already && <span className="ml-1 text-emerald-600">✓ registered</span>}
                <span className="block text-zinc-400">{opt.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={check}
          disabled={busy !== null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy === "check" ? "Checking…" : "Check columns"}
        </button>
        <button
          onClick={register}
          disabled={!isAdmin || busy !== null || selected.length === 0}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          title={!isAdmin ? "ADMIN only" : undefined}
        >
          {busy === "register" ? "Registering…" : "Register webhooks"}
        </button>
        <button
          onClick={fill}
          disabled={!isAdmin || busy !== null}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          title={!isAdmin ? "ADMIN only" : "One-time mirror backfill"}
        >
          {busy === "fill" ? "Filling…" : "Fill now"}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {result && <ResultView kind={result.kind} data={result.data} />}
    </div>
  );
}

function ResultView({ kind, data }: { kind: "check" | "register" | "fill"; data: unknown }) {
  if (kind === "check") return <ColumnCheckView data={data as ColumnCheck} />;
  if (kind === "fill") {
    const d = data as { total: number; synced: number; ready: number; pending: number; failed: number };
    return (
      <div className="mt-2 rounded-md bg-zinc-50 p-3 text-xs text-zinc-700">
        Backfill complete — <strong>{d.synced}/{d.total}</strong> mirrored ({d.ready} ready, {d.pending} pending,{" "}
        {d.failed} failed). Mirror-only: no jobs were fired.
      </div>
    );
  }
  const d = data as { created: { event: string }[]; skipped: string[]; foreign: { id: string; event: string }[] };
  return (
    <div className="mt-2 rounded-md bg-zinc-50 p-3 text-xs text-zinc-700">
      <div>Created: {d.created.length ? d.created.map((c) => c.event).join(", ") : "none"}</div>
      <div>Already registered (skipped): {d.skipped.length ? d.skipped.join(", ") : "none"}</div>
      {d.foreign.length > 0 && (
        <div className="mt-1 text-amber-700">
          Foreign webhooks on Monday not in our registry (left untouched): {d.foreign.map((f) => `${f.event}#${f.id}`).join(", ")}
        </div>
      )}
    </div>
  );
}

type ColumnCheck = {
  customer: { name: string } | null;
  warning?: string;
  ready?: boolean;
  mapped?: Array<{ field: string; columnId: string; required: boolean; existsOnBoard: boolean; title: string | null; type: string | null }>;
  requiredMissing?: Array<{ id: string; label: string }>;
  unmappedBoardColumns?: Array<{ id: string; title: string; type: string }>;
};

function ColumnCheckView({ data }: { data: ColumnCheck }) {
  if (data.warning) return <p className="mt-2 text-xs text-amber-700">{data.warning}</p>;
  return (
    <div className="mt-2 rounded-md bg-zinc-50 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium text-zinc-700">{data.customer?.name}</span>
        {data.ready ? <Pill tone="green">all synced columns present</Pill> : <Pill tone="red">missing columns</Pill>}
      </div>
      <table className="w-full">
        <thead className="text-left text-[11px] uppercase tracking-wide text-zinc-400">
          <tr>
            <th className="py-1 pr-2">Field</th>
            <th className="py-1 pr-2">Column id</th>
            <th className="py-1 pr-2">On board</th>
            <th className="py-1 pr-2">Title / type</th>
          </tr>
        </thead>
        <tbody>
          {data.mapped?.map((m) => (
            <tr key={m.field} className="border-t border-zinc-200">
              <td className="py-1 pr-2 text-zinc-700">
                {m.field}
                {m.required && <span className="ml-1 text-[10px] text-zinc-400">(required)</span>}
              </td>
              <td className="py-1 pr-2 font-mono text-zinc-600">{m.columnId}</td>
              <td className="py-1 pr-2">{m.existsOnBoard ? <Pill tone="green">yes</Pill> : <Pill tone="red">missing</Pill>}</td>
              <td className="py-1 pr-2 text-zinc-500">
                {m.existsOnBoard ? `${m.title ?? "—"} · ${m.type ?? "—"}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.requiredMissing && data.requiredMissing.length > 0 && (
        <p className="mt-2 text-red-700">
          Required fields not found on board: {data.requiredMissing.map((f) => `${f.label} (${f.id})`).join(", ")}
        </p>
      )}
      {data.unmappedBoardColumns && data.unmappedBoardColumns.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-zinc-500">
            {data.unmappedBoardColumns.length} board columns not in mapping
          </summary>
          <div className="mt-1 text-zinc-500">
            {data.unmappedBoardColumns.map((c) => (
              <div key={c.id}>
                <span className="font-mono">{c.id}</span> — {c.title} <span className="text-zinc-400">({c.type})</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function MondayPanel({ boards, isAdmin }: { boards: BoardSummary[]; isAdmin: boolean }) {
  const [adHoc, setAdHoc] = useState("");
  const trimmed = adHoc.trim();
  const adHocBoard: BoardSummary | null =
    trimmed && !boards.some((b) => b.boardId === trimmed)
      ? { boardId: trimmed, customers: [], events: [] }
      : null;

  return (
    <div className="space-y-3">
      {!isAdmin && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Register / Fill require an ADMIN role. You can still run column checks.
        </p>
      )}

      {boards.length === 0 && !adHocBoard && (
        <p className="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500">
          No board ids in any customer config yet. Add boards under a customer&apos;s <code>mondayBoardIds</code>,
          or enter one below.
        </p>
      )}

      {boards.map((b) => (
        <BoardCard key={b.boardId} board={b} isAdmin={isAdmin} />
      ))}

      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-4">
        <label className="text-xs font-medium text-zinc-700">
          Ad-hoc board id (not yet in a customer config)
          <input
            value={adHoc}
            onChange={(e) => setAdHoc(e.target.value)}
            placeholder="1234567890"
            className="mt-1 block w-full max-w-xs rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </label>
      </div>

      {adHocBoard && <BoardCard board={adHocBoard} isAdmin={isAdmin} />}
    </div>
  );
}

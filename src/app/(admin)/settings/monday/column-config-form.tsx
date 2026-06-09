"use client";

import { useState } from "react";

export type GlobalColumnConfig = {
  columnMapping: Record<string, string | undefined>;
  requiredFields: Array<{ id: string; label: string }>;
};

export function ColumnConfigForm({ initial, updatedAt, isAdmin }: { initial: GlobalColumnConfig; updatedAt: string; isAdmin: boolean }) {
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`JSON parse error: ${(err as Error).message}`);
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/admin/monday/column-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ? `${data.error}${data.details ? ` — ${JSON.stringify(data.details)}` : ""}` : `HTTP ${res.status}`);
        return;
      }
      setText(JSON.stringify({ columnMapping: data.config.columnMapping, requiredFields: data.config.requiredFields }, null, 2));
      setSaved(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <p className="text-xs text-zinc-500">
        One mapping, shared by every customer. <code>columnMapping</code> maps each field to a Monday column id;{" "}
        <code>requiredFields</code> are the column ids that must be filled for a style to be ready. Use{" "}
        <strong>Check columns</strong> on a board below to verify these ids exist before registering webhooks.
        <span className="ml-1 text-zinc-400">Last updated {new Date(updatedAt).toLocaleString()}.</span>
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        rows={22}
        spellCheck={false}
        disabled={!isAdmin}
        className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:bg-zinc-50"
      />
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {saved && <p className="mt-2 text-xs text-emerald-600">Saved.</p>}
      <div className="mt-2">
        <button
          onClick={save}
          disabled={!isAdmin || pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          title={!isAdmin ? "ADMIN only" : undefined}
        >
          {pending ? "Saving…" : "Save shared mapping"}
        </button>
      </div>
    </div>
  );
}

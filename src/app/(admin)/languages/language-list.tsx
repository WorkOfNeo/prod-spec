"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";

type LanguageRow = {
  id: string;
  code: string;
  name: string;
  nativeName: string | null;
  sortOrder: number;
  active: boolean;
};

type Props = {
  initialLanguages: LanguageRow[];
};

export function LanguageList({ initialLanguages }: Props) {
  const [dialog, setDialog] = useState<
    | { mode: "create" }
    | { mode: "edit"; row: LanguageRow }
    | null
  >(null);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <SeedButton />
        <button
          type="button"
          onClick={() => setDialog({ mode: "create" })}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          + New language
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">#</th>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Native name</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialLanguages.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                  No languages yet. Click <strong>Seed standard set</strong> for the 22 languages
                  in the Prod Spec spec.
                </td>
              </tr>
            ) : (
              initialLanguages.map((l) => (
                <tr key={l.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2 text-xs tabular-nums text-zinc-500">{l.sortOrder}</td>
                  <td className="px-4 py-2 font-mono text-xs">{l.code}</td>
                  <td className="px-4 py-2 font-medium">{l.name}</td>
                  <td className="px-4 py-2 text-zinc-600">{l.nativeName ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        l.active ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {l.active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setDialog({ mode: "edit", row: l })}
                      className="text-xs text-zinc-700 underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {dialog && (
        <LanguageDialog
          mode={dialog.mode}
          row={dialog.mode === "edit" ? dialog.row : null}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function SeedButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function seed() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/languages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedStandard: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsg(`error: ${body.error ?? res.statusText}`);
        return;
      }
      setMsg(`created ${body.created}, skipped ${body.skipped}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={seed}
        disabled={busy}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Seeding…" : "Seed standard set (22 langs)"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </div>
  );
}

function LanguageDialog({
  mode,
  row,
  onClose,
}: {
  mode: "create" | "edit";
  row: LanguageRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [nativeName, setNativeName] = useState(row?.nativeName ?? "");
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 999);
  const [active, setActive] = useState(row?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const url = mode === "create" ? "/api/admin/languages" : `/api/admin/languages/${row?.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload: Record<string, unknown> = {
        name,
        nativeName: nativeName.trim() ? nativeName : null,
        sortOrder,
      };
      if (mode === "create") payload.code = code;
      else payload.active = active;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!row) return;
    if (!confirm(`Delete language "${row.name}"? Translations keyed by ${row.code} will stop rendering. This is permanent — set Active off if you might re-enable later.`))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/languages/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <div className="my-12 w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {mode === "create" ? "New language" : `Edit ${row?.name}`}
          </h2>
          <button onClick={onClose} className="text-xs text-zinc-500 underline">
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-zinc-700">
            Code <span className="font-normal text-zinc-400">(BCP 47)</span>
            <input
              type="text"
              value={code}
              disabled={mode === "edit"}
              onChange={(e) => setCode(e.target.value)}
              maxLength={10}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm disabled:bg-zinc-50"
              placeholder="en, de-AT"
              required
            />
          </label>
          <label className="text-xs font-medium text-zinc-700">
            Sort order
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm tabular-nums"
              min={0}
              max={9999}
            />
          </label>
          <label className="col-span-2 text-xs font-medium text-zinc-700">
            Name (English)
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="English"
              required
            />
          </label>
          <label className="col-span-2 text-xs font-medium text-zinc-700">
            Native name <span className="font-normal text-zinc-400">(optional)</span>
            <input
              type="text"
              value={nativeName}
              onChange={(e) => setNativeName(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="English"
            />
          </label>
        </div>

        {mode === "edit" && (
          <div className="mt-5">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
          </div>
        )}

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          {mode === "edit" ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="text-xs text-red-600 underline disabled:opacity-50"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !code || !name}
              className="rounded-md bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

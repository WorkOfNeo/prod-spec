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
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + New language
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-xs text-muted">
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
                <td colSpan={6} className="px-4 py-12 text-center text-muted">
                  No languages yet. Click <strong>Seed standard set</strong> for the 22 languages
                  in the Prod Spec spec.
                </td>
              </tr>
            ) : (
              initialLanguages.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="px-4 py-2 text-xs tabular-nums text-muted">{l.sortOrder}</td>
                  <td className="px-4 py-2 font-mono text-xs">{l.code}</td>
                  <td className="px-4 py-2 font-medium">{l.name}</td>
                  <td className="px-4 py-2 text-muted">{l.nativeName ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        l.active ? "bg-good-soft text-good" : "bg-subtle text-muted"
                      }`}
                    >
                      {l.active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setDialog({ mode: "edit", row: l })}
                      className="text-xs text-ink underline"
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
        className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Seeding…" : "Seed standard set (22 langs)"}
      </button>
      {msg && <span className="text-xs text-muted">{msg}</span>}
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
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-[rgb(15_17_21/0.30)] p-6">
      <div className="my-12 w-full max-w-md rounded-lg bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {mode === "create" ? "New language" : `Edit ${row?.name}`}
          </h2>
          <button onClick={onClose} className="text-xs text-muted underline">
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-ink">
            Code <span className="font-normal text-faint">(BCP 47)</span>
            <input
              type="text"
              value={code}
              disabled={mode === "edit"}
              onChange={(e) => setCode(e.target.value)}
              maxLength={10}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-sm disabled:bg-subtle"
              placeholder="en, de-AT"
              required
            />
          </label>
          <label className="text-xs font-medium text-ink">
            Sort order
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm tabular-nums"
              min={0}
              max={9999}
            />
          </label>
          <label className="col-span-2 text-xs font-medium text-ink">
            Name (English)
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
              placeholder="English"
              required
            />
          </label>
          <label className="col-span-2 text-xs font-medium text-ink">
            Native name <span className="font-normal text-faint">(optional)</span>
            <input
              type="text"
              value={nativeName}
              onChange={(e) => setNativeName(e.target.value)}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
              placeholder="English"
            />
          </label>
        </div>

        {mode === "edit" && (
          <div className="mt-5">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
          </div>
        )}

        {err && <p className="mt-3 text-xs text-bad">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          {mode === "edit" ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="text-xs text-bad underline disabled:opacity-50"
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
              className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !code || !name}
              className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

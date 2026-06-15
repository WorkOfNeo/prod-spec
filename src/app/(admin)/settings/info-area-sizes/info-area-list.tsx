"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";

type InfoAreaSizeRow = {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  active: boolean;
};

export function InfoAreaList({ initialSizes }: { initialSizes: InfoAreaSizeRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<InfoAreaSizeRow | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
        >
          + New size
        </button>
        <span className="text-xs text-zinc-500">
          {initialSizes.length} size{initialSizes.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Size</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialSizes.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-zinc-500">
                  No info-area sizes yet. Click <strong>+ New size</strong> to add one (e.g.
                  &ldquo;Small · 40 × 60&rdquo;).
                </td>
              </tr>
            ) : (
              initialSizes.map((s) => (
                <tr key={s.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-medium text-zinc-900">{s.name}</td>
                  <td className="px-4 py-2 tabular-nums text-zinc-700">
                    {s.widthMm} × {s.heightMm} mm
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        s.active ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {s.active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(s)}
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

      {creating && (
        <SizeDialog
          title="New info area size"
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
      {editing && (
        <SizeDialog
          title="Edit info area size"
          mode="edit"
          size={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function SizeDialog({
  title,
  mode,
  size,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  size?: InfoAreaSizeRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(size?.name ?? "");
  const [widthMm, setWidthMm] = useState<string>(size ? String(size.widthMm) : "");
  const [heightMm, setHeightMm] = useState<string>(size ? String(size.heightMm) : "");
  const [active, setActive] = useState(size?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const w = Number(widthMm);
  const h = Number(heightMm);
  const valid =
    name.trim().length > 0 &&
    Number.isInteger(w) &&
    w > 0 &&
    w <= 1000 &&
    Number.isInteger(h) &&
    h > 0 &&
    h <= 1000;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const url =
        mode === "create" ? "/api/admin/info-area-sizes" : `/api/admin/info-area-sizes/${size!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload: Record<string, unknown> = {
        name: name.trim(),
        widthMm: w,
        heightMm: h,
      };
      if (mode === "edit") payload.active = active;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!size) return;
    if (!confirm("Delete this size? This is permanent — disabling it is safer.")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/info-area-sizes/${size.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="my-8 w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        <label className="block text-xs font-medium text-zinc-700">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            placeholder="Small"
          />
        </label>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-zinc-700">
            Width (mm)
            <input
              type="number"
              min={1}
              max={1000}
              value={widthMm}
              onChange={(e) => setWidthMm(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="40"
            />
          </label>
          <label className="text-xs font-medium text-zinc-700">
            Height (mm)
            <input
              type="number"
              min={1}
              max={1000}
              value={heightMm}
              onChange={(e) => setHeightMm(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="60"
            />
          </label>
        </div>

        {mode === "edit" && (
          <div className="mt-4">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
          </div>
        )}

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={destroy}
                disabled={busy}
                className="text-xs text-red-700 underline disabled:opacity-50"
              >
                Delete permanently
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !valid}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

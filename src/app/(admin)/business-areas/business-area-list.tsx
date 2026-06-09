"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";

type Area = {
  id: string;
  mondayValue: string;
  name: string;
  active: boolean;
  styleCount: number;
  prodSpecCount: number;
  lastSyncedAt: string;
  mergedInto: { id: string; name: string; mondayValue: string } | null;
};

export function BusinessAreaList({ initialAreas }: { initialAreas: Area[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Area | null>(null);
  const [creating, setCreating] = useState(false);

  async function seed() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/business-areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedStandard: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          + New business area
        </button>
        <button
          type="button"
          onClick={seed}
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Seed standard 7
        </button>
        <span className="text-xs text-zinc-500">
          Seeds PL, LICENSE, BRAND_HOUSE, LOVED, D2C, SPARK_SHOP, STOCK if they don&apos;t exist yet.
        </span>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Monday value</th>
              <th className="px-4 py-3">Display name</th>
              <th className="px-4 py-3">Styles</th>
              <th className="px-4 py-3">Prod specs</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Synced</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {initialAreas.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                  No business areas yet. Click <strong>Seed standard 7</strong> to pre-populate, or{" "}
                  <strong>+ New business area</strong> for a custom one.
                </td>
              </tr>
            ) : (
              initialAreas.map((a) => (
                <tr
                  key={a.id}
                  className={`border-t border-zinc-100 ${a.active ? "" : "opacity-60"}`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{a.mondayValue}</td>
                  <td className="px-4 py-3">
                    {a.name}
                    {a.mergedInto && (
                      <span
                        className="ml-2 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600"
                        title={`Merged into ${a.mergedInto.name} (${a.mergedInto.mondayValue})`}
                      >
                        → {a.mergedInto.name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{a.styleCount}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{a.prodSpecCount}</td>
                  <td className="px-4 py-3 text-zinc-600">{a.active ? "yes" : "no"}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{a.lastSyncedAt}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(a)}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
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
        <AreaDialog
          title="New business area"
          mode="create"
          allAreas={initialAreas}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      {editing && (
        <AreaDialog
          title={`Edit · ${editing.mondayValue}`}
          mode="edit"
          area={editing}
          allAreas={initialAreas}
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

function AreaDialog({
  title,
  mode,
  area,
  allAreas,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  area?: Area;
  allAreas: Area[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mondayValue, setMondayValue] = useState(area?.mondayValue ?? "");
  const [name, setName] = useState(area?.name ?? "");
  const [active, setActive] = useState(area?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");

  // Eligible merge targets: not this row, not already merged into
  // something else (i.e. canonical only), active. Sorted alphabetically.
  const mergeCandidates = allAreas
    .filter((a) => a.id !== area?.id && a.mergedInto === null && a.active)
    .sort((a, b) => a.name.localeCompare(b.name));

  async function merge() {
    if (!area || !mergeTargetId) return;
    const target = allAreas.find((a) => a.id === mergeTargetId);
    if (!target) return;
    const ok = window.confirm(
      `Merge "${area.name}" (${area.mondayValue}) into "${target.name}" (${target.mondayValue})?\n\n` +
        `• ${area.styleCount} style${area.styleCount === 1 ? "" : "s"} will be re-pointed.\n` +
        `• ${area.prodSpecCount} prod spec${area.prodSpecCount === 1 ? "" : "s"} will be moved or merged into the target's (target's outputs win on conflict).\n` +
        `• Future Monday items with mondayValue="${area.mondayValue}" will resolve to the target automatically.\n\n` +
        `This is mostly reversible (you can clear the alias later) but configured outputs lost in a merge are gone.`,
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/business-areas/${area.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: mergeTargetId }),
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

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const url =
        mode === "create"
          ? "/api/admin/business-areas"
          : `/api/admin/business-areas/${area!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload =
        mode === "create"
          ? { mondayValue, name }
          : { mondayValue, name, active };
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
    if (!area) return;
    if (
      !confirm(
        `Delete "${area.mondayValue}"? Fails if any ProdSpec is attached. Toggling Active off is safer.`,
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/business-areas/${area.id}`, { method: "DELETE" });
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        <label className="block text-xs font-medium text-zinc-700">
          Monday value *
          <input
            type="text"
            value={mondayValue}
            onChange={(e) => setMondayValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
            placeholder="PL"
            required
          />
          <span className="mt-1 block font-normal text-zinc-500">
            Exact string Monday&apos;s Business Area dropdown emits — ingest matches on this.
          </span>
        </label>

        <label className="mt-4 block text-xs font-medium text-zinc-700">
          Display name *
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            placeholder="Private Label"
            required
          />
        </label>

        {mode === "edit" && (
          <div className="mt-4">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
          </div>
        )}

        {mode === "edit" && area && (
          <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-3">
            {area.mergedInto ? (
              <p className="text-xs text-zinc-600">
                Already merged into{" "}
                <strong>
                  {area.mergedInto.name} ({area.mergedInto.mondayValue})
                </strong>
                . Future Monday items with this mondayValue redirect there.
              </p>
            ) : (
              <>
                <div className="mb-2 text-xs font-medium text-zinc-700">Merge into…</div>
                <div className="flex gap-2">
                  <select
                    value={mergeTargetId}
                    onChange={(e) => setMergeTargetId(e.target.value)}
                    className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                    disabled={busy}
                  >
                    <option value="">— pick canonical BA —</option>
                    {mergeCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.mondayValue})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={merge}
                    disabled={busy || !mergeTargetId}
                    className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {busy ? "Merging…" : "Merge"}
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-snug text-zinc-500">
                  Re-points styles + prod specs onto the canonical BA, marks this row as an
                  alias, and redirects future ingests. Use when Monday has variants like
                  &quot;PL&quot; and &quot;Private Label&quot; that should be one.
                </p>
              </>
            )}
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
              disabled={busy || !mondayValue || !name}
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

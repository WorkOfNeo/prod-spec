"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { TrimConceptRow } from "@/lib/trims/concepts";
import { DEFAULT_DELIVERED_STATUS, DEFAULT_PENDING_STATUS } from "@/lib/trims/concept-copy";

// The cover page's PACKAGING ROWS: the list of lines a cover can print, and the
// words each one says.
//
// A row is the shared vocabulary — the thing a Monday trim label and an Output
// Builder layout are BOTH matched onto. That is why the list is flat and global
// with no customer anywhere on it: "Care Label" exists once here, not once per
// customer, or the mapping would have to be redone for every customer we take
// on and would never be finished. The built-in rows sit in this same list and
// are edited the same way, so nothing is special-cased.
//
// Adding a row here is half the job; the other half is saying which Monday trim
// values land on it, which is Settings › Trims.
//
// PACKING INSTRUCTIONS GET THE NOTE AND NOTHING ELSE. A polybag, a hanger, a
// carton has no file behind it, so it can never be "delivered"; offering the
// status boxes would invite someone to park 1,733 styles' Master Polybag rows
// at "waiting" forever and bury the rows that genuinely are waiting. The server
// strips them too — this is not the only guard.
//
// REMOVE MEANS DEACTIVATE. Trim values and layouts point at a row by its id, so
// deleting one would silently re-open every mapping that named it. A removed
// row stops being offered and keeps resolving for anything still pointing at it.
//
// Empty wording box = the house default, shown greyed as the placeholder.

type Props = {
  initialRows: TrimConceptRow[];
};

type Draft = TrimConceptRow & {
  // Client-only key: a brand-new row has no id until the server mints one from
  // its label, and React still needs something stable to render it by.
  key: string;
};

const toDraft = (row: TrimConceptRow): Draft => ({ ...row, key: row.value });

export function PackagingRowsEditor({ initialRows }: Props) {
  const [rows, setRows] = useState<Draft[]>(() => initialRows.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const initialJson = useMemo(() => JSON.stringify(initialRows.map(toDraft)), [initialRows]);
  const dirty = JSON.stringify(rows) !== initialJson;

  const patch = useCallback((key: string, change: Partial<Draft>) => {
    setSaved(false);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }, []);

  const addRow = useCallback(() => {
    setSaved(false);
    setRows((prev) => [
      ...prev,
      {
        // No value yet — the server derives one from the label on save. Sending
        // a client-invented id would let two rows collide on it.
        key: `new-${Date.now()}-${prev.length}`,
        value: "",
        label: "",
        artwork: true,
        sortOrder: (prev.length + 1) * 10,
        builtIn: false,
        active: true,
      },
    ]);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/cover-page/packaging-rows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: rows
            .filter((r) => r.label.trim() !== "")
            .map((r, i) => ({
              // Omitted for a new row, so the server knows to mint one.
              ...(r.value ? { value: r.value } : {}),
              label: r.label.trim(),
              artwork: r.artwork,
              note: r.note ?? "",
              pending: r.pending ?? "",
              delivered: r.delivered ?? "",
              sortOrder: (i + 1) * 10,
              active: r.active,
            })),
        }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
      }
      // Repaint from what the server actually stored: it mints the ids for new
      // rows and drops the status wording from packing instructions, and a
      // screen still showing text the server threw away would be lying.
      const body = (await res.json()) as { rows?: TrimConceptRow[] };
      setRows((body.rows ?? []).map(toDraft));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [rows]);

  const removedCount = rows.filter((r) => !r.active).length;
  const shown = showRemoved ? rows : rows.filter((r) => r.active);

  return (
    <div className="mt-6">
      <p className="max-w-2xl text-sm text-zinc-500">
        Every line a cover page can print. A row is written once here — never once per client —
        because &ldquo;Care label&rdquo; is a different layout for each client and a per-client list
        would never be finished. Which Monday <strong>Trims</strong> values land on each row is set
        on{" "}
        <Link
          href="/settings/trims"
          className="font-medium text-zinc-700 underline underline-offset-2"
        >
          Settings › Trims
        </Link>
        .
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        The <strong>note</strong> is a standing fact about the document and prints in every state;
        the two status boxes are what the Status column says while the artwork is still to come, and
        once it is confirmed. Leave a box empty to use the wording shown greyed inside it. Changes
        apply to <strong>newly generated</strong> bundles — covers already in a supplier&rsquo;s
        folder keep their words until they are rebuilt.
      </p>

      <div className="mt-6 space-y-3">
        {shown.map((r) => (
          <div
            key={r.key}
            className={`rounded-lg border bg-white p-4 ${
              r.active ? "border-zinc-200" : "border-dashed border-zinc-300 opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={r.label}
                placeholder="Row name, e.g. Inlay card"
                onChange={(e) => patch(r.key, { label: e.target.value })}
                className="min-w-[14rem] flex-1 rounded border border-zinc-200 px-2 py-1.5 text-[13px] font-medium text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
              />
              <label className="flex items-center gap-2 text-[13px] text-zinc-600">
                <input
                  type="checkbox"
                  checked={!r.artwork}
                  onChange={(e) => patch(r.key, { artwork: !e.target.checked })}
                />
                Packing instruction — no file, so no delivery status
              </label>
              {r.builtIn && (
                <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-500">
                  built in
                </span>
              )}
              <button
                type="button"
                onClick={() => patch(r.key, { active: !r.active })}
                className="ml-auto rounded border border-zinc-300 px-2 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50"
              >
                {r.active ? "Remove" : "Restore"}
              </button>
            </div>

            {!r.active && (
              <p className="mt-2 text-[12px] text-zinc-500">
                Removed — it stops being offered for new mappings. Trim values already pointing at
                it keep printing this row and its wording, so nothing on a cover changes until they
                are re-mapped.
              </p>
            )}

            <div className="mt-3 space-y-2">
              <Field label="Note">
                <input
                  type="text"
                  value={r.note ?? ""}
                  placeholder="No note"
                  onChange={(e) => patch(r.key, { note: e.target.value })}
                  className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                />
              </Field>
              {r.artwork ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="Not yet delivered">
                    <input
                      type="text"
                      value={r.pending ?? ""}
                      placeholder={DEFAULT_PENDING_STATUS}
                      onChange={(e) => patch(r.key, { pending: e.target.value })}
                      className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                    />
                  </Field>
                  <Field label="Delivered">
                    <input
                      type="text"
                      value={r.delivered ?? ""}
                      placeholder={DEFAULT_DELIVERED_STATUS}
                      onChange={(e) => patch(r.key, { delivered: e.target.value })}
                      className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                    />
                  </Field>
                </div>
              ) : (
                <p className="text-[12px] text-zinc-400">
                  No status boxes: nothing is ever delivered for a packing instruction, so a status
                  would sit at &ldquo;waiting&rdquo; forever.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addRow}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Add a row
        </button>
        {removedCount > 0 && (
          <label className="flex items-center gap-2 text-[13px] text-zinc-500">
            <input
              type="checkbox"
              checked={showRemoved}
              onChange={(e) => setShowRemoved(e.target.checked)}
            />
            Show {removedCount} removed row{removedCount === 1 ? "" : "s"}
          </label>
        )}
        <div className="ml-auto flex items-center gap-3">
          {saved ? <span className="text-[13px] text-emerald-700">Saved</span> : null}
          {error ? <span className="text-[13px] text-red-600">{error}</span> : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {saving ? "Saving…" : "Save rows"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

"use client";

import { useState } from "react";

// One colour per row, its spellings comma-separated. A group needs at least two
// spellings to bridge anything, so the server drops shorter ones on save and
// answers with what it actually stored — this screen then shows that truth
// rather than what was typed.
export function ColourAliasEditor({ initialGroups }: { initialGroups: string[][] }) {
  const [rows, setRows] = useState<string[]>(() =>
    initialGroups.length > 0 ? initialGroups.map((g) => g.join(", ")) : [""],
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const parse = (text: string) =>
    text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/settings/colour-aliases", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: rows.map(parse) }),
      });
      const data = (await res.json()) as { groups?: string[][]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      const saved = data.groups ?? [];
      const dropped = rows.filter((r) => parse(r).length === 1).length;
      setRows(saved.length > 0 ? saved.map((g) => g.join(", ")) : [""]);
      setNote(
        dropped > 0
          ? `Saved ${saved.length} group${saved.length === 1 ? "" : "s"} — ${dropped} row${dropped === 1 ? "" : "s"} had only one spelling and bridged nothing, so ${dropped === 1 ? "it was" : "they were"} dropped.`
          : `Saved ${saved.length} group${saved.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={row}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? e.target.value : r)))}
              placeholder="LGM, Grey melange, Light grey melange"
              className="min-w-0 flex-1 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [""])}
              className="px-1 text-zinc-300 hover:text-red-600"
              aria-label="Remove this group"
              title="Remove this group"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setRows([...rows, ""])}
          className="text-[13px] font-medium text-zinc-700 hover:text-zinc-900"
        >
          + Add a colour
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {note ? <span className="text-[12px] text-zinc-500">{note}</span> : null}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-zinc-400">
        One colour per row, spellings separated by commas. Case and punctuation are ignored when
        matching, so &ldquo;grey melange&rdquo; and &ldquo;Grey Melange&rdquo; are already the same —
        a group is only needed for genuinely different words. Changes reach rendering within a few
        seconds.
      </p>
    </div>
  );
}

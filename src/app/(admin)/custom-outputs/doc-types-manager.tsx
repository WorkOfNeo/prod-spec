"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deriveDocTypeValue, type DocTypeEntry } from "@/lib/pdf/doc-types";

// =====================================================
// Document types card (Custom outputs overview) — see, rename, add and
// delete the doc-type catalogue the whole app categorises outputs by
// (builder type select, picker filter chips, asset grouping).
//
// Rules surfaced here, enforced by the API:
//   • value (storage key) is derived from the name once and immutable
//   • label renames are display-only and always safe
//   • delete only when nothing carries the value (layouts / generated
//     assets / legacy templates / coded variants)
// =====================================================

export type ManagedDocType = DocTypeEntry & {
  usage: { layouts: number; assets: number; templates: number; builtinVariants: boolean };
};

function usageSummary(u: ManagedDocType["usage"]): string | null {
  const parts: string[] = [];
  if (u.builtinVariants) parts.push("built-in outputs");
  if (u.layouts > 0) parts.push(`${u.layouts} layout${u.layouts === 1 ? "" : "s"}`);
  if (u.assets > 0) parts.push(`${u.assets} generated file${u.assets === 1 ? "" : "s"}`);
  if (u.templates > 0) parts.push(`${u.templates} template${u.templates === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function DocTypesManager({ initialTypes }: { initialTypes: ManagedDocType[] }) {
  const router = useRouter();
  const [types, setTypes] = useState(initialTypes);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // value → draft label while a row's input is focused/edited
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function refetch() {
    const res = await fetch("/api/admin/doc-types");
    if (res.ok) {
      const body = (await res.json()) as { types: ManagedDocType[] };
      setTypes(body.types);
    }
    // Server components on this and other pages render labels too.
    router.refresh();
  }

  async function add() {
    const label = newLabel.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/doc-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Add failed (${res.status})`);
        return;
      }
      setNewLabel("");
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel(value: string) {
    const draft = (drafts[value] ?? "").trim();
    const current = types.find((t) => t.value === value);
    setDrafts((d) => {
      const next = { ...d };
      delete next[value];
      return next;
    });
    if (!current || !draft || draft === current.label) return;
    setError(null);
    const res = await fetch(`/api/admin/doc-types/${encodeURIComponent(value)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: draft }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? `Rename failed (${res.status})`);
      return;
    }
    await refetch();
  }

  async function remove(value: string) {
    setError(null);
    const res = await fetch(`/api/admin/doc-types/${encodeURIComponent(value)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? `Delete failed (${res.status})`);
      return;
    }
    await refetch();
  }

  const derived = deriveDocTypeValue(newLabel);

  return (
    <div id="doc-types" className="mb-8 rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">Document types</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          The categories outputs are tagged and grouped by — the type select in the Output Builder,
          the filter chips in the prod-spec output picker, and the grouping of delivered files.
          Renaming changes the display name everywhere; a type can be deleted only while nothing uses
          it.
        </p>
      </div>

      <ul className="divide-y divide-zinc-100">
        {types.map((t) => {
          const used = usageSummary(t.usage);
          return (
            <li key={t.value} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
              <input
                type="text"
                value={drafts[t.value] ?? t.label}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.value]: e.target.value }))}
                onBlur={() => void saveLabel(t.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape")
                    setDrafts((d) => {
                      const next = { ...d };
                      delete next[t.value];
                      return next;
                    });
                }}
                className="w-44 rounded-md border border-transparent px-2 py-1 text-sm text-zinc-800 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
                aria-label={`Label for ${t.value}`}
              />
              <code className="rounded bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">{t.value}</code>
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-zinc-400">
                {used ?? "not used yet"}
              </span>
              <button
                type="button"
                onClick={() => void remove(t.value)}
                disabled={used !== null}
                title={used ? `In use: ${used}` : "Delete this type"}
                className="text-xs text-zinc-400 enabled:hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-5 py-3">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="New type name — e.g. Insert card"
          className="w-64 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
        />
        {newLabel.trim() && derived ? (
          <code className="font-mono text-[11px] text-zinc-400">→ {derived}</code>
        ) : null}
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || !newLabel.trim()}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white enabled:hover:bg-zinc-700 disabled:opacity-40"
        >
          Add type
        </button>
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </div>
  );
}

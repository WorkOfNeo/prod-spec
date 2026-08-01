"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deriveDocTypeValue, type DocTypeEntry } from "@/lib/pdf/doc-types";
import type { OutputRule } from "@/lib/outputs/exclusion";
import { OutputRulesEditor } from "@/components/output-rules-editor";

// =====================================================
// Document types manager (Output Builder → "Document types" popup) — see,
// rename, add and delete the doc-type catalogue the whole app categorises
// outputs by (builder type select, picker filter chips, asset grouping), AND
// edit each type's keyword GENERATION RULES.
//
// A rule gates every output of the type on a synced field: "don't generate
// when Product group contains shoes/sock" (sock and shoe styles skip wash
// care), or the other direction, "generate only when …". Either way the review
// shows why a document is missing. Rules persist on the DocTypeDef via PATCH
// /api/admin/doc-types/<value>; the same editor sets rules for ONE output in a
// layout's Settings tab (Output Builder → the layout → Settings).
//
// Other rules surfaced here, enforced by the API:
//   • value (storage key) is derived from the name once and immutable
//   • label renames are display-only and always safe
//   • delete only when nothing carries the value
// =====================================================

export type ManagedDocType = DocTypeEntry & {
  usage: { layouts: number; assets: number; templates: number; builtinVariants: boolean };
  rules: OutputRule[];
};

export type ExclusionFieldOption = { field: string; label: string };

function usageSummary(u: ManagedDocType["usage"]): string | null {
  const parts: string[] = [];
  if (u.builtinVariants) parts.push("built-in outputs");
  if (u.layouts > 0) parts.push(`${u.layouts} layout${u.layouts === 1 ? "" : "s"}`);
  if (u.assets > 0) parts.push(`${u.assets} generated file${u.assets === 1 ? "" : "s"}`);
  if (u.templates > 0) parts.push(`${u.templates} template${u.templates === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function DocTypesManager({
  initialTypes,
  fields,
}: {
  initialTypes: ManagedDocType[];
  fields: ExclusionFieldOption[];
}) {
  const router = useRouter();
  const [types, setTypes] = useState(initialTypes);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // value → draft label while a row's input is focused/edited
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // value → whether the rules panel is expanded
  const [openRules, setOpenRules] = useState<Record<string, boolean>>({});

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
    <div id="doc-types">
      <p className="px-1 text-xs leading-relaxed text-zinc-500">
        The categories outputs are tagged and grouped by — the type select in the Output Builder, the
        filter chips in the prod-spec output picker, and the grouping of delivered files. Renaming
        changes the display name everywhere; a type can be deleted only while nothing uses it. Add{" "}
        <span className="font-medium text-zinc-600">keyword rules</span> to decide which styles get a
        type at all — skip it for the ones that match (socks/shoes skip wash care), or generate it
        only for them. To rule a SINGLE output rather than a whole type, use that layout&apos;s
        Settings tab.
      </p>

      <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
        {types.map((t) => {
          const used = usageSummary(t.usage);
          const ruleCount = t.rules.length;
          const expanded = openRules[t.value] ?? false;
          return (
            <li key={t.value} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
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
                <code className="rounded bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
                  {t.value}
                </code>
                <button
                  type="button"
                  onClick={() => setOpenRules((o) => ({ ...o, [t.value]: !expanded }))}
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    ruleCount > 0
                      ? "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300"
                      : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                  }`}
                  aria-expanded={expanded}
                  title="Keyword rules deciding which styles get this type"
                >
                  {ruleCount > 0
                    ? `${ruleCount} rule${ruleCount === 1 ? "" : "s"}`
                    : "Add rule"}{" "}
                  {expanded ? "▲" : "▾"}
                </button>
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
              </div>

              {expanded && (
                <DocTypeRulesEditor
                  label={t.label}
                  value={t.value}
                  initialRules={t.rules}
                  fields={fields}
                  onSaved={refetch}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
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

// Keyword rules for one doc type — the shared editor plus this scope's own
// "Save rules" PATCH. Local draft until saved, so a half-typed keyword list
// never reaches the DB.
function DocTypeRulesEditor({
  label,
  value,
  initialRules,
  fields,
  onSaved,
}: {
  label: string;
  value: string;
  initialRules: OutputRule[];
  fields: ExclusionFieldOption[];
  onSaved: () => Promise<void> | void;
}) {
  const [rules, setRules] = useState<OutputRule[]>(initialRules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/doc-types/${encodeURIComponent(value)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exclusionRules: rules }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Save failed (${res.status})`);
        return;
      }
      setSaved(true);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="mb-1.5 text-[11px] font-medium text-zinc-600">
        Rules for every <span className="font-semibold">{label}</span> output
      </div>
      <OutputRulesEditor
        subject={label}
        initialRules={initialRules}
        fields={fields}
        onChange={(next) => {
          setSaved(false);
          setRules(next);
        }}
        footer={
          <>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-md bg-zinc-900 px-3 py-1 text-[11px] font-medium text-white enabled:hover:bg-zinc-700 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save rules"}
            </button>
            {saved && !error ? <span className="text-[11px] text-emerald-600">Saved ✓</span> : null}
            {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
          </>
        }
      />
    </div>
  );
}

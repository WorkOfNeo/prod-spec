"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deriveDocTypeValue, type DocTypeEntry } from "@/lib/pdf/doc-types";
import type { ExclusionOp, ExclusionRule } from "@/lib/outputs/exclusion";

// =====================================================
// Document types manager (Output Builder → "Document types" popup) — see,
// rename, add and delete the doc-type catalogue the whole app categorises
// outputs by (builder type select, picker filter chips, asset grouping), AND
// edit each type's keyword EXCLUSION RULES.
//
// A rule says "don't generate any output of this type for a style when a
// synced field matches a keyword" — e.g. Wash care → Product group contains
// "shoes"/"sock" means sock/shoe styles skip wash-care, and the review shows
// why. Rules persist on the DocTypeDef via PATCH /api/admin/doc-types/<value>.
//
// Other rules surfaced here, enforced by the API:
//   • value (storage key) is derived from the name once and immutable
//   • label renames are display-only and always safe
//   • delete only when nothing carries the value
// =====================================================

export type ManagedDocType = DocTypeEntry & {
  usage: { layouts: number; assets: number; templates: number; builtinVariants: boolean };
  rules: ExclusionRule[];
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
        <span className="font-medium text-zinc-600">keyword rules</span> to skip generating a type for
        styles that match (e.g. socks/shoes skip wash care).
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
                  title="Keyword rules that skip generating this type"
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

// Editable keyword-rule list for one doc type. Local draft until "Save rules"
// PATCHes it; keywords are entered comma/newline-separated and split on save.
type RuleDraft = { field: string; op: ExclusionOp; keywordsText: string };

function DocTypeRulesEditor({
  label,
  value,
  initialRules,
  fields,
  onSaved,
}: {
  label: string;
  value: string;
  initialRules: ExclusionRule[];
  fields: ExclusionFieldOption[];
  onSaved: () => Promise<void> | void;
}) {
  const defaultField = fields[0]?.field ?? "productGroup";
  const [drafts, setDrafts] = useState<RuleDraft[]>(
    initialRules.map((r) => ({ field: r.field, op: r.op, keywordsText: r.keywords.join(", ") })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  function update(i: number, patch: Partial<RuleDraft>) {
    setSavedAt(false);
    setDrafts((d) => d.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRule() {
    setSavedAt(false);
    setDrafts((d) => [...d, { field: defaultField, op: "contains", keywordsText: "" }]);
  }
  function removeRule(i: number) {
    setSavedAt(false);
    setDrafts((d) => d.filter((_, idx) => idx !== i));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const rules: ExclusionRule[] = drafts
      .map((d) => ({
        field: d.field,
        op: d.op,
        keywords: d.keywordsText
          .split(/[,\n]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.field && r.keywords.length > 0);
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
      setSavedAt(true);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="text-[11px] font-medium text-zinc-600">
        Don’t generate <span className="font-semibold">{label}</span> when…
      </div>

      {drafts.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-zinc-400">
          No rules — every style gets this type. Add one to skip it for matching styles.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {drafts.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
              <select
                value={fields.some((f) => f.field === r.field) ? r.field : "__other__"}
                onChange={(e) => update(i, { field: e.target.value })}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-zinc-700"
              >
                {fields.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
                {!fields.some((f) => f.field === r.field) && (
                  <option value="__other__">{r.field}</option>
                )}
              </select>
              <select
                value={r.op}
                onChange={(e) => update(i, { op: e.target.value as ExclusionOp })}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-zinc-700"
              >
                <option value="contains">contains</option>
                <option value="equals">equals</option>
              </select>
              <input
                type="text"
                value={r.keywordsText}
                onChange={(e) => update(i, { keywordsText: e.target.value })}
                placeholder="shoes, boot, sandal, sock…"
                className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-zinc-700 placeholder:text-zinc-400"
                aria-label="Keywords (comma-separated)"
              />
              <button
                type="button"
                onClick={() => removeRule(i)}
                className="px-1 text-zinc-400 hover:text-red-600"
                title="Remove rule"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addRule}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:border-zinc-400"
        >
          + Add rule
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1 text-[11px] font-medium text-white enabled:hover:bg-zinc-700 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save rules"}
        </button>
        {savedAt && !error ? <span className="text-[11px] text-emerald-600">Saved ✓</span> : null}
        {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400">
        Keywords are comma-separated, case-insensitive. Any match skips every {label} output for that
        style — the review shows the reason. “contains” matches substrings; “equals” needs the whole
        field to match.
      </p>
    </div>
  );
}

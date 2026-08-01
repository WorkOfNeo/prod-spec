"use client";

import { useState } from "react";
import { ruleSentence, type RuleMode, type RuleOp, type OutputRule } from "@/lib/outputs/exclusion";

// =====================================================
// Generation-rule rows — "Generate when …" / "Don't generate when …" against a
// synced style field. Shared by the two places rules are configured, so the
// wording, the field list and the comma-separated keyword handling can't drift
// apart:
//   • Output Builder → Document types popup — rules for a whole doc type.
//   • Output Builder → a layout's Settings tab — rules for that ONE output.
//
// Presentational and uncontrolled-by-design: it owns nothing but the keyword
// TEXT of each row (a raw string while you type, split on save/blur), and hands
// the parsed rules back through onChange. The doc-types manager saves them with
// its own button; the layout editor lets its autosave pick them up.
// =====================================================

export type RuleFieldOption = { field: string; label: string };

// What the editor emits: an OutputRule with `mode` always written out. The
// engine reads a missing mode as "exclude", but being explicit keeps the
// stored JSON self-describing — and lets a caller store it in a schema that
// requires the field (LayoutSettings.rules).
export type EditedRule = OutputRule & { mode: RuleMode };

// A row mid-edit: keywords stay one raw string so typing "shoes, bo" doesn't
// churn the parsed list on every keystroke.
type RuleDraft = { field: string; op: RuleOp; mode: RuleMode; keywordsText: string };

export function draftsFromRules(rules: OutputRule[]): RuleDraft[] {
  return rules.map((r) => ({
    field: r.field,
    op: r.op,
    mode: r.mode === "include" ? "include" : "exclude",
    keywordsText: r.keywords.join(", "),
  }));
}

export function rulesFromDrafts(drafts: RuleDraft[]): EditedRule[] {
  return drafts
    .map((d) => ({
      field: d.field,
      op: d.op,
      mode: d.mode,
      keywords: d.keywordsText
        .split(/[,\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    }))
    .filter((r) => r.field && r.keywords.length > 0);
}

export function OutputRulesEditor({
  // What the rules apply to, in the operator's words — "Wash care" (a doc
  // type) or "Shoe barcode sticker" (one output). Used in the row wording.
  subject,
  initialRules,
  fields,
  onChange,
  // Rendered under the rows — the doc-types manager puts its Save button here;
  // the layout editor (autosaving) puts a hint.
  footer,
}: {
  subject: string;
  initialRules: OutputRule[];
  fields: RuleFieldOption[];
  onChange: (rules: EditedRule[]) => void;
  footer?: React.ReactNode;
}) {
  const defaultField = fields[0]?.field ?? "productGroup";
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => draftsFromRules(initialRules));

  function commit(next: RuleDraft[]) {
    setDrafts(next);
    onChange(rulesFromDrafts(next));
  }
  function update(i: number, patch: Partial<RuleDraft>) {
    commit(drafts.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRule(mode: RuleMode) {
    commit([...drafts, { field: defaultField, op: "contains", mode, keywordsText: "" }]);
  }
  function removeRule(i: number) {
    commit(drafts.filter((_, idx) => idx !== i));
  }

  const parsed = rulesFromDrafts(drafts);
  const hasInclude = parsed.some((r) => r.mode === "include");

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      {drafts.length === 0 ? (
        <p className="text-[11px] text-zinc-400">
          No rules — <span className="font-medium text-zinc-500">{subject}</span> is generated for
          every style that declares it. Add one to limit it.
        </p>
      ) : (
        <div className="space-y-2">
          {drafts.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
              {/* The direction. Colour-coded because the two read almost the
                  same but do opposite things. */}
              <select
                value={r.mode}
                onChange={(e) => update(i, { mode: e.target.value as RuleMode })}
                className={`rounded-md border px-2 py-1.5 font-medium ${
                  r.mode === "include"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : "border-amber-300 bg-amber-50 text-amber-900"
                }`}
                aria-label="Rule direction"
              >
                <option value="include">Generate when</option>
                <option value="exclude">Don’t generate when</option>
              </select>
              <select
                value={fields.some((f) => f.field === r.field) ? r.field : "__other__"}
                onChange={(e) => update(i, { field: e.target.value })}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-zinc-700"
                aria-label="Field"
              >
                {fields.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
                {/* A field that's no longer offered still round-trips. */}
                {!fields.some((f) => f.field === r.field) && (
                  <option value="__other__">{r.field}</option>
                )}
              </select>
              <select
                value={r.op}
                onChange={(e) => update(i, { op: e.target.value as RuleOp })}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-zinc-700"
                aria-label="Match type"
              >
                <option value="contains">contains</option>
                <option value="equals">equals</option>
              </select>
              <input
                type="text"
                value={r.keywordsText}
                onChange={(e) => update(i, { keywordsText: e.target.value })}
                placeholder="shoes, boot, sandal…"
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

      {/* Plain-English read-back of what the rows now mean, so the operator
          confirms the behaviour rather than the form. */}
      {parsed.length > 0 ? (
        <ul className="mt-2.5 space-y-0.5 border-t border-zinc-200 pt-2">
          {parsed.map((r, i) => (
            <li key={i} className="text-[11px] text-zinc-500">
              <span className="text-zinc-400">·</span> {ruleSentence(r)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addRule("include")}
          className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
        >
          + Generate when
        </button>
        <button
          type="button"
          onClick={() => addRule("exclude")}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-50"
        >
          + Don’t generate when
        </button>
        {footer}
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400">
        Keywords are comma-separated and case-insensitive — “contains” matches substrings,
        “equals” needs the whole field. A <span className="font-medium">Don’t generate</span>{" "}
        match always wins.
        {hasInclude ? (
          <>
            {" "}
            With a <span className="font-medium">Generate when</span> rule set,{" "}
            <span className="font-medium text-zinc-500">{subject}</span> is generated ONLY for
            styles matching one of them — including never, while the field is still empty. The
            style and review screens show the reason.
          </>
        ) : (
          " The style and review screens show the reason an output was skipped."
        )}
      </p>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  CONDITION_OPS,
  CONDITION_OP_LABELS,
  activeShowWhenRules,
  blockShown,
  conditionOpIsNumeric,
  conditionOpTakesValue,
  conditionText,
  type BlockConditionRule,
  type BlockShowWhen,
  type ConditionOp,
} from "@/lib/output-layouts/schema";
import { LAYOUT_TOKENS } from "@/lib/output-layouts/token-meta";

// =====================================================
// The Output Builder's condition pickers — one field · operator · value row,
// used twice: on a BLOCK ("Show only when…", block.showWhen) and to write an
// inline {{if …}}…{{endif}} into the content without typing the syntax.
// Both speak the same operators (schema.ts CONDITION_OPS), so a rule picked
// here reads the same as one typed by hand.
// =====================================================

// What a condition can test: the text variables (a barcode or symbol has no
// value to compare). Bare keys only — {{if}} takes no argument.
const CONDITION_FIELDS = LAYOUT_TOKENS.filter((t) => t.kind === "text");
const FIELD_GROUPS = [...new Set(CONDITION_FIELDS.map((t) => t.group))];
const DEFAULT_FIELD = CONDITION_FIELDS.some((t) => t.key === "productGroup")
  ? "productGroup"
  : (CONDITION_FIELDS[0]?.key ?? "");

const inputCls = "rounded border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-700";

// A palette label is written for the chip's tooltip ("Customer item no (bare =
// this row's size). :product picks…"); the picker wants just the name. Cut at
// the first aside (" — ", ". ", " :"), then drop a parenthesis unless it's a
// short plain qualifier that tells two fields apart — "Carton no (this
// print)" vs "Carton no (zero-padded to total)". The full label stays as the
// option's title.
function fieldName(label: string): string {
  const head = label.split(/ — |\. | :/)[0];
  const paren = /^(.*?) \(([^)]*)\)?(.*)$/.exec(head);
  if (!paren) return head.trim() || label;
  const [, name, inner, rest] = paren;
  const plain = head.includes(")") && inner.length <= 24 && !/[:{=]/.test(inner);
  return (plain ? `${name} (${inner})${rest}` : name).trim() || label;
}

// Picker text per field; where two fields would read the same (the
// per-language composition variants) the variable key tells them apart.
const FIELD_NAMES = (() => {
  const names = CONDITION_FIELDS.map((t) => fieldName(t.label));
  return new Map(
    CONDITION_FIELDS.map((t, i) => [
      t.key,
      names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? `${names[i]} · ${t.key}` : names[i],
    ]),
  );
})();

export type TextRange = { start: number; end: number };

function ConditionRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: BlockConditionRule;
  onChange: (patch: Partial<BlockConditionRule>) => void;
  onRemove?: () => void;
}) {
  // A rule on a field that's since left the palette still shows (and stays
  // put) rather than silently snapping to another field.
  const known = CONDITION_FIELDS.some((t) => t.key === rule.field);
  // Field on its own line: the block panel is narrow and field labels are
  // long ("Customer item no."); operator · value · remove share the next.
  return (
    <div className="space-y-1">
      <select
        value={rule.field}
        onChange={(e) => onChange({ field: e.target.value })}
        className={`${inputCls} w-full`}
        aria-label="Condition field"
      >
        {!known ? <option value={rule.field}>{rule.field || "Pick a field…"}</option> : null}
        {FIELD_GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {CONDITION_FIELDS.filter((t) => t.group === group).map((t) => (
              <option key={t.key} value={t.key} title={t.label}>
                {FIELD_NAMES.get(t.key)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="flex items-center gap-1">
        <select
          value={rule.op}
          onChange={(e) => {
            const op = e.target.value as ConditionOp;
            onChange(conditionOpTakesValue(op) ? { op } : { op, value: "" });
          }}
          className={inputCls}
          aria-label="Condition operator"
        >
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {CONDITION_OP_LABELS[op]}
            </option>
          ))}
        </select>
        {conditionOpTakesValue(rule.op) ? (
          <input
            value={rule.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder={conditionOpIsNumeric(rule.op) ? "number" : "value (empty = blank)"}
            inputMode={conditionOpIsNumeric(rule.op) ? "decimal" : undefined}
            className={`${inputCls} w-20 min-w-0 flex-1`}
            aria-label="Condition value"
          />
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="flex h-6 w-6 items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
            title="Remove this rule"
            aria-label="Remove this rule"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Every field a rule reads has a value in the preview's resolved set? Only
// then can the panel say whether the block prints on the test style.
function evaluable(rules: BlockConditionRule[], values: Record<string, string>): boolean {
  return rules.every((r) => Object.prototype.hasOwnProperty.call(values, r.field));
}

// Is this block hidden on the style whose values these are? False whenever
// that can't be told (no rules, or the values haven't loaded yet) — the canvas
// only fades a block it KNOWS won't print.
export function hiddenByValues(block: { showWhen?: BlockShowWhen }, values: Record<string, string>): boolean {
  const active = activeShowWhenRules(block);
  if (active.length === 0 || !evaluable(active, values)) return false;
  return !blockShown(block, (f) => values[f] ?? "");
}

export function BlockShowWhenEditor({
  showWhen,
  onChange,
  values,
  valuesFrom,
  repeats,
}: {
  showWhen: BlockShowWhen | undefined;
  // undefined clears the setting — the block prints on every style again.
  onChange: (next: BlockShowWhen | undefined) => void;
  // The test style's resolved variables (the preview's tokenValues).
  values: Record<string, string>;
  valuesFrom: string | undefined;
  // The layout repeats per size/EAN row, so a row-scoped field ({{size}})
  // can hide the block on some rows and not others.
  repeats: boolean;
}) {
  const rules = showWhen?.rules ?? [];
  const match = showWhen?.match ?? "all";
  const set = (nextRules: BlockConditionRule[], nextMatch = match) =>
    onChange(nextRules.length > 0 ? { match: nextMatch, rules: nextRules } : undefined);

  if (rules.length === 0) {
    return (
      <div>
        <button
          type="button"
          onClick={() => set([{ field: DEFAULT_FIELD, op: "is set", value: "" }])}
          className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
          title="Print this block only on styles that match — e.g. only when Product group contains Set, or only when the polybag quantity is set"
        >
          + Show only when…
        </button>
      </div>
    );
  }

  const active = activeShowWhenRules({ showWhen });
  const status =
    active.length > 0 && evaluable(active, values) ? blockShown({ showWhen }, (f) => values[f] ?? "") : null;

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-zinc-600">
          Show only when{" "}
          {rules.length > 1 ? (
            <>
              <select
                value={match}
                onChange={(e) => set(rules, e.target.value as BlockShowWhen["match"])}
                className={inputCls}
                aria-label="Match all or any rule"
              >
                <option value="all">all</option>
                <option value="any">any</option>
              </select>{" "}
              of these are true
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="text-[11px] font-medium text-zinc-400 hover:text-red-600"
          title="Remove the condition — the block prints on every style again"
        >
          Remove
        </button>
      </div>
      <div className="mt-1.5 space-y-2 divide-y divide-zinc-200/70 [&>*+*]:pt-2">
        {rules.map((rule, i) => (
          <ConditionRow
            key={i}
            rule={rule}
            onChange={(patch) => set(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))}
            onRemove={() => set(rules.filter((_, j) => j !== i))}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => set([...rules, { field: DEFAULT_FIELD, op: "is set", value: "" }])}
        disabled={rules.length >= 20}
        className="mt-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-40"
      >
        + Add rule
      </button>
      {status !== null && valuesFrom ? (
        <p className={`mt-1 text-[11px] ${status ? "text-emerald-700" : "text-amber-700"}`}>
          {status ? "Prints" : "Hidden"} on {valuesFrom}
          {repeats ? " (checked against the whole style — a per-size field can differ row by row)" : ""}.
        </p>
      ) : null}
      <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
        When the rules don&apos;t hold, the block doesn&apos;t print and its cell stays empty. Its variables aren&apos;t
        waited on either.
      </p>
    </div>
  );
}

// The "If…" button beside B / I on the content editor: pick a condition and
// it wraps the selected text in {{if …}}…{{endif}} (or adds a fresh one).
// The selection is captured on mousedown — picking the condition moves focus
// off the textarea, which would otherwise lose it.
export function InsertConditionButton({
  captureSelection,
  onInsert,
  disabled,
  size = "sm",
}: {
  captureSelection: () => { range: TextRange | null; spansLines: boolean };
  onInsert: (condition: string, withElse: boolean, range: TextRange | null) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [rule, setRule] = useState<BlockConditionRule>({
    field: DEFAULT_FIELD,
    op: "is set",
    value: "",
  });
  const [withElse, setWithElse] = useState(false);
  const [captured, setCaptured] = useState<{
    range: TextRange | null;
    spansLines: boolean;
  }>({
    range: null,
    spansLines: false,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const hasSelection = captured.range !== null && captured.range.end > captured.range.start;
  const btnCls =
    size === "md"
      ? "rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
      : "rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-50";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => {
          e.preventDefault();
          if (!open) setCaptured(captureSelection());
        }}
        onClick={() => setOpen((v) => !v)}
        className={`${btnCls} font-mono disabled:opacity-40`}
        title="Insert a condition — wraps the selected text in {{if …}}…{{endif}} so it prints only when the condition holds"
      >
        If…
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-80 rounded-md border border-zinc-200 bg-white p-3 text-left shadow-lg">
          <div className="text-xs font-medium text-zinc-700">
            {hasSelection ? "Print the selected text only when…" : "Insert a condition where…"}
          </div>
          <div className="mt-2">
            <ConditionRow rule={rule} onChange={(patch) => setRule((r) => ({ ...r, ...patch }))} />
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={withElse}
              onChange={(e) => setWithElse(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            Add an {"{{else}}"} for when it doesn&apos;t
          </label>
          <code className="mt-2 block break-all rounded bg-zinc-50 px-1.5 py-1 font-mono text-[10px] text-zinc-500">
            {`{{if ${conditionText(rule.field, rule.op, rule.value)}}}${hasSelection ? "…" : ""}${withElse ? "{{else}}" : ""}{{endif}}`}
          </code>
          {captured.spansLines ? (
            <p className="mt-1 text-[11px] text-amber-700">
              A condition lives on one line — select text within a single line, or use the block&apos;s &ldquo;Show only
              when…&rdquo; to hide several lines at once.
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={captured.spansLines || !rule.field}
              onClick={() => {
                onInsert(conditionText(rule.field, rule.op, rule.value), withElse, captured.range);
                setOpen(false);
              }}
              className="rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
            >
              {hasSelection ? "Wrap selection" : "Insert"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

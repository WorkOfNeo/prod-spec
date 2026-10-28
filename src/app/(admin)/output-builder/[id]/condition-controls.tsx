"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
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
import { buttonClass } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";

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

const inputCls = "rounded border border-line bg-surface px-1.5 py-1 text-xs text-ink";

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
type CapturedSelection = { range: TextRange | null; spansLines: boolean };
const NO_SELECTION: CapturedSelection = { range: null, spansLines: false };

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
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:bg-subtle hover:text-bad"
            title="Remove this rule"
            aria-label="Remove this rule"
          >
            <X size={14} aria-hidden="true" />
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
          className="text-xs font-medium text-muted hover:text-ink"
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
    <div className="rounded-md border border-line bg-subtle/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted">
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
          className="text-[11px] font-medium text-faint hover:text-bad"
          title="Remove the condition — the block prints on every style again"
        >
          Remove
        </button>
      </div>
      <div className="mt-1.5 space-y-2 divide-y divide-line [&>*+*]:pt-2">
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
        className="mt-1.5 text-[11px] font-medium text-muted hover:text-ink disabled:opacity-40"
      >
        + Add rule
      </button>
      {status !== null && valuesFrom ? (
        <p className={`mt-1 text-[11px] ${status ? "text-good" : "text-warn"}`}>
          {status ? "Prints" : "Hidden"} on {valuesFrom}
          {repeats ? " (checked against the whole style — a per-size field can differ row by row)" : ""}.
        </p>
      ) : null}
      <p className="mt-1 text-[11px] leading-relaxed text-faint">
        When the rules don&apos;t hold, the block doesn&apos;t print and its cell stays empty. Its variables aren&apos;t
        waited on either.
      </p>
    </div>
  );
}

// The "If…" button beside B / I on the content editor: pick a condition and
// it wraps the selected text in {{if …}}…{{endif}} (or adds a fresh one).
// The selection is read on the button's mousedown — picking the condition
// moves focus off the textarea, which would otherwise lose it. The picker
// floats on the top layer (the shared Popover), so the narrow, scrolling
// inspector doesn't clip it.
export function InsertConditionButton({
  anchor,
  captureSelection,
  onInsert,
  size = "sm",
}: {
  // The picker's CSS anchor name, unique on the page: the inspector's button
  // stays mounted under the expanded editor's.
  anchor: `--${string}`;
  captureSelection: () => CapturedSelection;
  onInsert: (condition: string, withElse: boolean, range: TextRange | null) => void;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [rule, setRule] = useState<BlockConditionRule>({
    field: DEFAULT_FIELD,
    op: "is set",
    value: "",
  });
  const [withElse, setWithElse] = useState(false);
  const [captured, setCaptured] = useState<CapturedSelection>(NO_SELECTION);
  // Read on mousedown, taken when the picker opens. Opened from the keyboard
  // there is none — focus is on the button, not the text.
  const pressed = useRef<CapturedSelection | null>(null);

  // Esc closes the picker only — not the expanded editor around it, which
  // closes on any Esc that reaches the window.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const hasSelection = captured.range !== null && captured.range.end > captured.range.start;
  const btnCls =
    size === "md"
      ? "rounded border border-line px-2 py-1 font-mono text-xs text-muted hover:bg-subtle"
      : "rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-subtle";
  const close = (el: Element) => (el.closest("[popover]") as HTMLElement | null)?.hidePopover();

  return (
    <div
      onMouseDown={(e) => {
        // The button only — a press inside the open picker is the user picking.
        if (e.target instanceof Element && e.target.closest("[popover]")) return;
        e.preventDefault();
        pressed.current = captureSelection();
      }}
    >
      <Popover
        anchor={anchor}
        align="end"
        label="If… — insert a condition"
        className={btnCls}
        trigger={
          <span title="Insert a condition — wraps the selected text in {{if …}}…{{endif}} so it prints only when the condition holds">
            If…
          </span>
        }
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setCaptured(pressed.current ?? NO_SELECTION);
          pressed.current = null;
        }}
      >
        <div className="w-72 p-2 text-left">
          <div className="text-xs font-medium text-ink">
            {hasSelection ? "Print the selected text only when…" : "Insert a condition where…"}
          </div>
          <div className="mt-2">
            <ConditionRow rule={rule} onChange={(patch) => setRule((r) => ({ ...r, ...patch }))} />
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={withElse}
              onChange={(e) => setWithElse(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-line text-ink"
            />
            Add an {"{{else}}"} for when it doesn&apos;t
          </label>
          <code className="mt-2 block break-all rounded bg-subtle px-1.5 py-1 font-mono text-[11px] text-muted">
            {`{{if ${conditionText(rule.field, rule.op, rule.value)}}}${hasSelection ? "…" : ""}${withElse ? "{{else}}" : ""}{{endif}}`}
          </code>
          {captured.spansLines ? (
            <p className="mt-1 text-[11px] text-warn">
              A condition lives on one line — select text within a single line, or use the block&apos;s &ldquo;Show only
              when…&rdquo; to hide several lines at once.
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={(e) => close(e.currentTarget)} className={buttonClass("ghost", "sm")}>
              Cancel
            </button>
            <button
              type="button"
              disabled={captured.spansLines || !rule.field}
              onClick={(e) => {
                onInsert(conditionText(rule.field, rule.op, rule.value), withElse, captured.range);
                close(e.currentTarget);
              }}
              className={buttonClass("primary", "sm")}
            >
              {hasSelection ? "Wrap selection" : "Insert"}
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

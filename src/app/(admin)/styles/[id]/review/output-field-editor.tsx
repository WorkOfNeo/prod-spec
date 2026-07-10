"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PINNABLE_FIELDS,
  PINNABLE_FIELD_LABELS,
  isPinnableField,
  type PinnableField,
} from "@/lib/pdf/pins-meta";

// Inline field editor for ONE output (or ONE PDF of a multi-doc output) of ONE
// style. Used on two review surfaces:
//   • Missing-field fill: `fields` are the blocking pinnable fields with empty
//     `resolved` values (type them in → "Save & generate"). `locked` lists the
//     non-pinnable blockers (sizes/EANs/wash care) read-only with a Monday note.
//   • Generated-output edit: `fields` are the fields the output prints, each
//     pre-filled with its CURRENT resolved value (`resolved[f]`) or the existing
//     override (`overrides[f]`) → "Save & re-render".
//
// Only fields the reviewer CHANGES are persisted. A field left at its resolved
// value is never stored — so it stays dynamic against future Monday data (no
// silent pinning). Clearing an override (or editing back to the resolved value)
// deletes the override. Save POSTs to /api/admin/styles/[id]/output-fields,
// which stores the values (by the given variantKey — base or "base#suffix" for
// a single PDF) and re-renders the output through the runner, then we refresh.
export function OutputFieldEditor({
  styleId,
  variantKey,
  outputName,
  submitLabel,
  fields = [],
  resolved = {},
  overrides = {},
  locked = [],
  allowAdd = false,
  mondayHref,
}: {
  styleId: string;
  variantKey: string;
  outputName: string;
  submitLabel: string;
  // Pinnable field keys shown as editable inputs.
  fields?: string[];
  // Current resolved (would-print) value per field — the pre-fill + the
  // "unchanged" baseline that is never persisted.
  resolved?: Record<string, string>;
  // Current stored override per field (wins over resolved in the input).
  overrides?: Record<string, string>;
  // Read-only non-pinnable blockers (missing-field surface only).
  locked?: { field: string; label: string }[];
  allowAdd?: boolean;
  mondayHref?: string;
}) {
  const router = useRouter();

  // Signature of the server-provided data; when it changes (after a refresh),
  // reset local edit state so the inputs reflect the freshly-rendered values.
  const sig = JSON.stringify({ fields, resolved, overrides });

  const buildShown = () =>
    [...new Set([...fields, ...Object.keys(overrides)])].filter(isPinnableField) as PinnableField[];
  const buildValues = (shownList: PinnableField[]) => {
    const m: Record<string, string> = {};
    for (const f of shownList) m[f] = overrides[f] ?? resolved[f] ?? "";
    return m;
  };

  const [shown, setShown] = useState<PinnableField[]>(buildShown);
  const [values, setValues] = useState<Record<string, string>>(() => buildValues(buildShown()));
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [addField, setAddField] = useState<PinnableField | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = buildShown();
    setShown(next);
    setValues(buildValues(next));
    setDirty(new Set());
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const available = PINNABLE_FIELDS.filter((f) => !shown.includes(f));

  function setVal(f: PinnableField, v: string) {
    setValues((p) => ({ ...p, [f]: v }));
    setDirty((p) => new Set(p).add(f));
  }
  function add() {
    if (!addField || !isPinnableField(addField)) return;
    setShown((p) => (p.includes(addField) ? p : [...p, addField]));
    setValues((p) => (addField in p ? p : { ...p, [addField]: overrides[addField] ?? resolved[addField] ?? "" }));
    setAddField("");
  }

  async function save() {
    // Persist only CHANGED fields; a value equal to the resolved baseline (or
    // blank) clears the override so the field reverts to live data.
    const payload: Record<string, string> = {};
    for (const f of dirty) {
      const v = (values[f] ?? "").trim();
      payload[f] = v && v !== (resolved[f] ?? "").trim() ? v : "";
    }
    if (Object.keys(payload).length === 0) {
      setError("No changes to save.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/output-fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKey, outputName, values: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (${res.status})`);
        setPending(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setPending(false);
    }
  }

  const hasChanges = dirty.size > 0;

  return (
    <div className="space-y-2">
      {locked.length > 0 ? (
        <p className="text-[11px] leading-relaxed text-amber-800">
          Not editable here — fill on{" "}
          {mondayHref ? (
            <a href={mondayHref} target="_blank" rel="noopener noreferrer" className="font-medium underline">
              Monday
            </a>
          ) : (
            "Monday"
          )}
          :{" "}
          {locked.map((m, i) => (
            <span key={m.field}>
              {i > 0 ? ", " : ""}
              <span className="font-medium">{m.label}</span>
            </span>
          ))}
        </p>
      ) : null}

      {shown.length > 0 ? (
        <div className="space-y-1.5">
          {shown.map((f) => {
            const isOverride = (values[f] ?? "").trim() !== "" && (values[f] ?? "").trim() !== (resolved[f] ?? "").trim();
            return (
              <label key={f} className="flex items-center gap-2">
                <span className="flex w-32 shrink-0 items-center gap-1 text-[11px] font-medium text-zinc-600">
                  {PINNABLE_FIELD_LABELS[f]}
                  {isOverride ? (
                    <span
                      title="Overridden — differs from the value on Monday"
                      className="rounded-sm bg-amber-100 px-1 text-[9px] font-semibold uppercase text-amber-700"
                    >
                      edited
                    </span>
                  ) : null}
                </span>
                <input
                  type="text"
                  value={values[f] ?? ""}
                  disabled={pending}
                  onChange={(e) => setVal(f, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  placeholder={resolved[f] ? resolved[f] : "type a value…"}
                  className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                />
              </label>
            );
          })}
        </div>
      ) : null}

      {allowAdd ? (
        <div className="flex items-center gap-1.5">
          <select
            value={addField}
            disabled={pending || available.length === 0}
            onChange={(e) => setAddField(e.target.value as PinnableField | "")}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px]"
          >
            <option value="">Add a field…</option>
            {available.map((f) => (
              <option key={f} value={f}>
                {PINNABLE_FIELD_LABELS[f]}
              </option>
            ))}
          </select>
          {addField ? (
            <button
              type="button"
              onClick={add}
              disabled={pending}
              className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Add
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-[11px] font-medium text-red-700">{error}</p> : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={pending || !hasChanges}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Re-rendering…" : submitLabel}
      </button>
    </div>
  );
}

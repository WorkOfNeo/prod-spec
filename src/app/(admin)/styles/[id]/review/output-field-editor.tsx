"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PINNABLE_FIELDS,
  PINNABLE_FIELD_LABELS,
  isPinnableField,
  type PinnableField,
} from "@/lib/pdf/pins-meta";

// Inline field editor for ONE output of ONE style. Two shapes, one component:
//   • Missing-field fill (accordion): `missing` lists the blocking fields.
//     Pinnable ones become editable inputs (fill → "Save & generate"); the
//     non-pinnable ones (sizes, EANs, wash care) stay read-only with the
//     "fill on Monday" note — they can't be free-typed.
//   • Override (generated card): `allowAdd` shows a field picker so the
//     reviewer can override any supported field on an already-generated output
//     ("Save & re-render"), pre-filled with the current per-style values.
//
// Save POSTs to /api/admin/styles/[id]/output-fields, which stores the values
// (per style + output) and re-renders the output through the runner — so the
// filled value both unblocks generation and prints. On success we refresh.
export function OutputFieldEditor({
  styleId,
  variantKey,
  outputName,
  submitLabel,
  missing = [],
  initialValues = {},
  allowAdd = false,
  mondayHref,
}: {
  styleId: string;
  variantKey: string;
  outputName: string;
  submitLabel: string;
  // Blocking fields from readiness ({field, label}); split into editable vs
  // locked by whether the field is pinnable.
  missing?: { field: string; label: string }[];
  // Current per-style override values (generated-card edit), field → value.
  initialValues?: Record<string, string>;
  allowAdd?: boolean;
  mondayHref?: string;
}) {
  const router = useRouter();

  const missingEditable = useMemo(
    () => missing.filter((m) => isPinnableField(m.field)),
    [missing],
  );
  const lockedFields = useMemo(
    () => missing.filter((m) => !isPinnableField(m.field)),
    [missing],
  );

  // Labels for every field we show an input for (missing + already-overridden).
  const labelFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of missingEditable) map.set(m.field, m.label);
    for (const f of Object.keys(initialValues)) {
      if (isPinnableField(f)) map.set(f, PINNABLE_FIELD_LABELS[f]);
    }
    return map;
  }, [missingEditable, initialValues]);

  // The fields shown as inputs: the missing pinnable ones + any already
  // overridden + any the reviewer adds via the picker. Order preserved.
  const [fields, setFields] = useState<PinnableField[]>(() => {
    const seen = new Set<string>();
    const list: PinnableField[] = [];
    for (const m of missingEditable) {
      if (isPinnableField(m.field) && !seen.has(m.field)) {
        seen.add(m.field);
        list.push(m.field);
      }
    }
    for (const f of Object.keys(initialValues)) {
      if (isPinnableField(f) && !seen.has(f)) {
        seen.add(f);
        list.push(f);
      }
    }
    return list;
  });

  const [values, setValues] = useState<Record<string, string>>(() => ({ ...initialValues }));
  const [addField, setAddField] = useState<PinnableField | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = PINNABLE_FIELDS.filter((f) => !fields.includes(f));

  function add() {
    if (!addField) return;
    setFields((prev) => (prev.includes(addField) ? prev : [...prev, addField]));
    setAddField("");
  }

  async function save() {
    setPending(true);
    setError(null);
    try {
      // Send every shown field (blank ones are deleted server-side, clearing
      // that override). A missing-field save with all blanks is a no-op re-run.
      const payload: Record<string, string> = {};
      for (const f of fields) payload[f] = (values[f] ?? "").trim();
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
      // The output re-rendered and re-entered review — pull the fresh state.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setPending(false);
    }
  }

  const hasInputs = fields.length > 0;

  return (
    <div className="space-y-2">
      {lockedFields.length > 0 ? (
        <p className="text-[11px] leading-relaxed text-amber-800">
          Not editable here — fill on{" "}
          {mondayHref ? (
            <a
              href={mondayHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline"
            >
              Monday
            </a>
          ) : (
            "Monday"
          )}
          :{" "}
          {lockedFields.map((m, i) => (
            <span key={m.field}>
              {i > 0 ? ", " : ""}
              <span className="font-medium">{m.label}</span>
            </span>
          ))}
        </p>
      ) : null}

      {hasInputs ? (
        <div className="space-y-1.5">
          {fields.map((f) => (
            <label key={f} className="flex items-center gap-2">
              <span className="w-32 shrink-0 text-[11px] font-medium text-zinc-600">
                {labelFor.get(f) ?? PINNABLE_FIELD_LABELS[f]}
              </span>
              <input
                type="text"
                value={values[f] ?? ""}
                disabled={pending}
                onChange={(e) => setValues((prev) => ({ ...prev, [f]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
                placeholder="type a value…"
                className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs"
              />
            </label>
          ))}
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

      {hasInputs ? (
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Re-rendering…" : submitLabel}
        </button>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useMemo, useState } from "react";
import type { TrimConcept } from "@/lib/trims/concepts";
import {
  DEFAULT_DELIVERED_STATUS,
  DEFAULT_PENDING_STATUS,
  type TrimConceptCopy,
  type TrimConceptCopyMap,
} from "@/lib/trims/concept-copy";

// The words a cover uses for each KIND of packaging.
//
// It lives on the Cover page screen because that is where a person goes to
// write cover prose, even though the data is keyed by trim concept rather than
// by customer. Keying it by concept is the point: "Care Label" is a different
// layout for every customer, so a sentence about care labels typed into cover
// blocks would have to be typed ~30 times and retyped for every customer taken
// on afterwards. Said once here, it prints wherever a care label prints.
//
// Three fields, and only the first applies to everything:
//
//   Note       — a standing fact about the document. Not a status: it prints
//                whether the artwork has arrived or not.
//   Not yet    — the status while the artwork is still to come.
//   Delivered  — the status once it is confirmed.
//
// PACKING INSTRUCTIONS GET THE NOTE AND NOTHING ELSE. A polybag, a hanger, a
// carton has no file behind it, so it can never be "delivered"; offering the
// status fields would invite someone to park 1,733 styles' Master Polybag rows
// at "waiting" forever and bury the rows that genuinely are waiting. The server
// strips them too — this is not the only guard.
//
// Empty box = the house default (shown greyed as the placeholder). Clearing a
// box you had filled is how a seeded default is restored.

type Props = {
  concepts: TrimConcept[];
  // The seeded defaults, so an inherited value shows as a placeholder rather
  // than as something a person typed.
  defaults: TrimConceptCopyMap;
  // The stored OVERRIDE layer only.
  initialCopy: TrimConceptCopyMap;
};

type Field = keyof TrimConceptCopy;

export function TrimCopyEditor({ concepts, defaults, initialCopy }: Props) {
  const [copy, setCopy] = useState<Record<string, TrimConceptCopy>>(() => ({ ...initialCopy }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((concept: string, field: Field, value: string) => {
    setSaved(false);
    setCopy((prev) => ({ ...prev, [concept]: { ...prev[concept], [field]: value } }));
  }, []);

  const valueOf = (concept: string, field: Field): string => copy[concept]?.[field] ?? "";

  // What the cover would print for this concept right now — the typed value, or
  // the default underneath it. Shown as the placeholder so the two are never
  // confused for one another.
  const placeholderOf = (concept: string, field: Field): string => {
    const seeded = defaults[concept]?.[field]?.trim();
    if (seeded) return seeded;
    if (field === "pending") return DEFAULT_PENDING_STATUS;
    if (field === "delivered") return DEFAULT_DELIVERED_STATUS;
    return "No note";
  };

  const dirty = useMemo(
    () => JSON.stringify(copy) !== JSON.stringify(initialCopy),
    [copy, initialCopy],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/cover-page/trim-copy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copy }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
      }
      // Repaint from what the server actually stored — it drops the status
      // wording from packing instructions, and a screen that kept showing text
      // the server threw away would be lying.
      const body = (await res.json()) as { copy?: TrimConceptCopyMap };
      setCopy({ ...(body.copy ?? {}) });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [copy]);

  return (
    <div className="mt-6">
      <p className="max-w-2xl text-sm text-zinc-500">
        The words a cover uses for each <strong>kind</strong> of packaging — written once here
        rather than once per client. The <strong>note</strong> is a standing fact about the
        document and prints in every state; the two status boxes are what the Status column says
        while the artwork is still to come, and once it is confirmed.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        Leave a box empty to use the wording shown greyed inside it. Changes apply to
        <strong> newly generated</strong> bundles — covers already in a supplier&rsquo;s folder keep
        their words until they are rebuilt.
      </p>

      <div className="mt-6 divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        {concepts.map((c) => (
          <div key={c.value} className="grid grid-cols-1 gap-3 p-4 md:grid-cols-[13rem_1fr]">
            <div>
              <div className="text-sm font-medium text-zinc-800">{c.label}</div>
              {c.artwork ? null : (
                <div className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  Packing instruction — no file, so no delivery status.
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Row label="Note">
                <input
                  type="text"
                  value={valueOf(c.value, "note")}
                  placeholder={placeholderOf(c.value, "note")}
                  onChange={(e) => set(c.value, "note", e.target.value)}
                  className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                />
              </Row>
              {c.artwork ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Row label="Not yet delivered">
                    <input
                      type="text"
                      value={valueOf(c.value, "pending")}
                      placeholder={placeholderOf(c.value, "pending")}
                      onChange={(e) => set(c.value, "pending", e.target.value)}
                      className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                    />
                  </Row>
                  <Row label="Delivered">
                    <input
                      type="text"
                      value={valueOf(c.value, "delivered")}
                      placeholder={placeholderOf(c.value, "delivered")}
                      onChange={(e) => set(c.value, "delivered", e.target.value)}
                      className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                    />
                  </Row>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {saving ? "Saving…" : "Save wording"}
        </button>
        {saved ? <span className="text-[13px] text-emerald-700">Saved</span> : null}
        {error ? <span className="text-[13px] text-red-600">{error}</span> : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

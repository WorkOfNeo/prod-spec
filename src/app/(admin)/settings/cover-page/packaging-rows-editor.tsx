"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { TrimConceptRow } from "@/lib/trims/concepts";
import { DEFAULT_DELIVERED_STATUS, DEFAULT_PENDING_STATUS } from "@/lib/trims/concept-copy";
import {
  bindLabelToRow,
  labelsBoundToRow,
  otherRowsForLabel,
  unbindLabelFromRow,
  unbindingWouldSuppress,
  type BindableLabel,
  type TrimLabelOverrides,
} from "@/lib/trims/row-bindings";
import { CoverSamplePdf } from "./cover-sample-pdf";

// The cover page's PACKAGING ROWS: the list of lines a cover can print, and the
// words each one says.
//
// A row is the shared vocabulary — the thing a Monday trim label and an Output
// Builder layout are BOTH matched onto. That is why the list is flat and global
// with no customer anywhere on it: "Care Label" exists once here, not once per
// customer, or the mapping would have to be redone for every customer we take
// on and would never be finished. The built-in rows sit in this same list and
// are edited the same way, so nothing is special-cased.
//
// WHICH MONDAY VALUES LAND ON A ROW is editable from here too, per row, and
// Settings › Trims edits the same thing from the value side. Two views, ONE
// store: both write the `trimLabelOverrides` record through PUT
// /api/admin/settings/trims, and the inversion (value -> rows becomes row ->
// values) is a pure function in src/lib/trims/row-bindings.ts. A row-keyed copy
// of the mapping would be the obvious shortcut and the obvious bug — the two
// would disagree the moment one was edited, and a cover would print whichever
// the render chain happened to read.
//
// The value side stays the queue ("172 values, 41 still need a decision"); this
// side is the answer to the other question a person actually asks, which is
// "what ends up on THIS line". Neither is a subset of the other, which is why
// both exist.
//
// The vocabulary comes from the census, which is already scoped to the
// generation PO cutoff — dead orders' words are not offered. It is fetched
// after paint because it reads every style's Trims cell; the wording boxes are
// usable while it loads.
//
// PACKING INSTRUCTIONS GET THE NOTE AND NOTHING ELSE. A polybag, a hanger, a
// carton has no file behind it, so it can never be "delivered"; offering the
// status boxes would invite someone to park 1,733 styles' Master Polybag rows
// at "waiting" forever and bury the rows that genuinely are waiting. The server
// strips them too — this is not the only guard.
//
// REMOVE MEANS DEACTIVATE. Trim values and layouts point at a row by its id, so
// deleting one would silently re-open every mapping that named it. A removed
// row stops being offered and keeps resolving for anything still pointing at it.
//
// REMOVE IS NOT HIDE, and this screen has to make that legible because a person
// reaching for one will reach for the other. Removing a row is about THIS LIST:
// it stops being offered for new mappings, and every value already on it keeps
// printing exactly as before. Hiding a row ("Print on the cover", off) is about
// THE PAGE: the row stays in the list, stays mappable, and stops reaching
// paper. Hiding changes what covers say, so those covers rebuild — which is why
// it is a deliberate tick and not a side effect of tidying up.
//
// AND HIDING A ROW IS NOT THE SAME LEVER AS DROPPING A VALUE. Taking the last
// row off a Monday value (below, or in Settings › Trims) hides that WORD; this
// hides a KIND of packaging however it is worded, including documents this app
// generates itself. Both are said in one line each next to the control.
//
// Empty wording box = the house default, shown greyed as the placeholder.
//
// AND UNDERNEATH IT ALL, THE PAGE ITSELF. A person editing these rows is
// editing a list, but what they are answerable for is a cover, so the panel at
// the bottom renders a real one for a real style — the existing sample-pdf
// route, through the same builder publish uses, with the trims forced on so it
// shows what flipping the master switch would produce. It persists nothing.
// Beside it is the one thing that DOES change an existing cover: a link to
// "Regenerate a style" on the General information tab. That control is not
// duplicated here, because the cover is a single PDF and it already rebuilds
// all of it — a second copy of a control that overwrites suppliers' files is
// only a second place for it to drift.
//
// NOTHING ON THIS SCREEN IS RETROACTIVE, and it says so three times on purpose:
// once in the preamble for the wording, once at the visible/hidden tick (the
// control that most reads like a delete), and once beside the rebuild link.
// Saving changes what is generated NEXT; no cover already in a folder moves.
//
// AND WHILE THE MASTER SWITCH IS OFF, NOTHING HERE REACHES A COVER AT ALL —
// buildRequiredPackagingForStyle takes its pre-Trims branch, which has no
// concept, no wording and no per-row flags in it. So this screen leads with
// that, because the alternative is somebody hiding a row, seeing no change
// anywhere, and reporting a bug against behaviour that is exactly right.

type Props = {
  initialRows: TrimConceptRow[];
  // The master switch, read on the server beside the rows. While it is OFF
  // there is no trim context at all, so nothing configured on this screen —
  // wording, always-by-hand, hidden — reaches a single cover, and a person
  // editing here deserves to be told that before they wonder why hiding a row
  // did nothing. It is a fact stated, not a control: flipping it lives on the
  // Cover page tab, next to the preview that justifies flipping it.
  trimsEnabled: boolean;
};

type Draft = TrimConceptRow & {
  // Client-only key: a brand-new row has no id until the server mints one from
  // its label, and React still needs something stable to render it by.
  key: string;
};

const toDraft = (row: TrimConceptRow): Draft => ({ ...row, key: row.value });

export function PackagingRowsEditor({ initialRows, trimsEnabled }: Props) {
  const [rows, setRows] = useState<Draft[]>(() => initialRows.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  // The trim mapping, held exactly as it is stored: normalised value -> row ids.
  // `null` until the census answers, which is what tells the pickers to say
  // "loading" rather than "no values on this row yet" — the second is a claim,
  // and it would be a false one.
  const [overrides, setOverrides] = useState<TrimLabelOverrides | null>(null);
  const [labels, setLabels] = useState<BindableLabel[] | null>(null);
  const [vocabState, setVocabState] = useState<"loading" | "ready" | "failed">("loading");
  // What is actually stored, as last read or last written. Held separately from
  // `overrides` (the edited copy) because the mapping is a DIFFERENT store with
  // its own endpoint — the one Save button below writes both.
  const [savedOverrides, setSavedOverrides] = useState<TrimLabelOverrides | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/settings/trims")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { overrides?: TrimLabelOverrides; census?: { labels?: BindableLabel[] } | null }) => {
        if (cancelled) return;
        // The census is the half that can fail on its own (see the endpoint).
        // Without it there is no vocabulary to offer, so the pickers stand down
        // rather than offering an empty list that looks like an answer.
        if (!d.census?.labels) {
          setVocabState("failed");
          return;
        }
        setOverrides(d.overrides ?? {});
        // The baseline the dirty check compares against, captured at the moment
        // it was read and moved forward only by a successful save.
        setSavedOverrides(d.overrides ?? {});
        setLabels(d.census.labels);
        setVocabState("ready");
      })
      .catch(() => {
        if (!cancelled) setVocabState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mappingDirty =
    overrides !== null &&
    savedOverrides !== null &&
    JSON.stringify(overrides) !== JSON.stringify(savedOverrides);

  const initialJson = useMemo(() => JSON.stringify(initialRows.map(toDraft)), [initialRows]);
  const rowsDirty = JSON.stringify(rows) !== initialJson;
  const dirty = rowsDirty || mappingDirty;

  // Row id -> its name, for "also on Hangtag" beside a value that lands on
  // several. Every row resolves, removed ones included: a value can still point
  // at a retired row, and printing a raw id there would look like corruption.
  const rowLabel = useMemo(
    () => new Map(rows.filter((r) => r.value).map((r) => [r.value, r.label.trim() || r.value])),
    [rows],
  );

  const patch = useCallback((key: string, change: Partial<Draft>) => {
    setSaved(false);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }, []);

  const addRow = useCallback(() => {
    setSaved(false);
    setRows((prev) => [
      ...prev,
      {
        // No value yet — the server derives one from the label on save. Sending
        // a client-invented id would let two rows collide on it.
        key: `new-${Date.now()}-${prev.length}`,
        value: "",
        label: "",
        artwork: true,
        sortOrder: (prev.length + 1) * 10,
        builtIn: false,
        active: true,
        // A new row supplies itself the way every other row does and prints —
        // both flags start at the value that changes nothing.
        alwaysManual: false,
        printOnCover: true,
      },
    ]);
  }, []);

  // ONE BUTTON, TWO ENDPOINTS. The mapping goes first: it can only ever name
  // rows that already have an id, so it is never the write that depends on the
  // other one landing. (A row added in this session has no id until the rows
  // PUT mints one, which is why its picker is disabled until then — see below.)
  // Each write is atomic for its own store; if the second fails, the first
  // stands and the screen stays dirty for the part that did not save, which is
  // the honest outcome. Inventing a transaction across two settings blobs to
  // protect an edit a person can simply press Save on again is not worth it.
  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (mappingDirty && overrides) {
        const mapRes = await fetch("/api/admin/settings/trims", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // Only `overrides` — the rules and the layout pins are not this
          // screen's to touch, and the endpoint saves whichever parts are sent.
          body: JSON.stringify({ overrides }),
        });
        if (!mapRes.ok) {
          throw new Error(
            (await mapRes.json().catch(() => null))?.error ?? `Failed (${mapRes.status})`,
          );
        }
        setSavedOverrides(overrides);
      }
      const res = await fetch("/api/admin/settings/cover-page/packaging-rows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: rows
            .filter((r) => r.label.trim() !== "")
            .map((r, i) => ({
              // Omitted for a new row, so the server knows to mint one.
              ...(r.value ? { value: r.value } : {}),
              label: r.label.trim(),
              artwork: r.artwork,
              note: r.note ?? "",
              pending: r.pending ?? "",
              delivered: r.delivered ?? "",
              sortOrder: (i + 1) * 10,
              active: r.active,
              // Sent even for a packing instruction, where the control is
              // disabled: the server strips it rather than trusting the form.
              alwaysManual: r.alwaysManual,
              printOnCover: r.printOnCover,
            })),
        }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
      }
      // Repaint from what the server actually stored: it mints the ids for new
      // rows and drops the status wording from packing instructions, and a
      // screen still showing text the server threw away would be lying.
      const body = (await res.json()) as { rows?: TrimConceptRow[] };
      setRows((body.rows ?? []).map(toDraft));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [rows, overrides, mappingDirty]);

  const removedCount = rows.filter((r) => !r.active).length;
  const shown = showRemoved ? rows : rows.filter((r) => r.active);

  return (
    <div className="mt-6">
      {/* SAID FIRST, BECAUSE IT CHANGES WHAT EVERY OTHER SENTENCE ON THE SCREEN
          MEANS. With the master switch off there is no trim context, so
          buildRequiredPackagingForStyle takes its pre-Trims branch and NOTHING
          configured here reaches a cover — not the wording, not the two ticks.
          Hiding a row today does nothing, and that is correct, not broken. A
          screen that let someone hide a row and then say nothing would be
          inviting them to conclude the feature is faulty. */}
      {!trimsEnabled && (
        <div className="mb-6 max-w-3xl rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] leading-relaxed text-sky-900">
          <strong>Trims on cover pages is off, so none of this is printing yet.</strong> Rows,
          wording and both ticks are all stored and all inert: covers currently list the layouts we
          generate, exactly as they always have. Hiding a row today changes nothing — and it will
          still change nothing already delivered once the switch is on. Use{" "}
          <em>See it on a real cover</em> below to look at what turning it on would produce; the
          switch itself is on the{" "}
          <Link
            href="/settings/cover-page"
            className="font-medium text-sky-900 underline underline-offset-2"
          >
            Cover page
          </Link>{" "}
          tab.
        </div>
      )}
      <p className="max-w-2xl text-sm text-zinc-500">
        Every line a cover page can print. A row is written once here — never once per client —
        because &ldquo;Care label&rdquo; is a different layout for each client and a per-client list
        would never be finished. Each row also says which Monday <strong>Trims</strong> values land
        on it; the same mapping read the other way round — value by value, worst-first — is{" "}
        <Link
          href="/settings/trims"
          className="font-medium text-zinc-700 underline underline-offset-2"
        >
          Settings › Trims
        </Link>
        . It is one mapping: a change made here shows up there, and the other way about.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        The <strong>note</strong> is a standing fact about the document and prints in every state;
        the two status boxes are what the Status column says while the artwork is still to come, and
        once it is confirmed. Leave a box empty to use the wording shown greyed inside it. Changes
        apply to <strong>newly generated</strong> bundles — covers already in a supplier&rsquo;s
        folder keep their words until they are rebuilt.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        Each row also decides two things about the packaging itself:{" "}
        <strong>always supplied by hand</strong> keeps the line an upload even once a layout
        produces it, and <strong>print on the cover</strong> decides whether the row appears at all.
        Neither is <em>Remove</em>: a removed row is only retired from this list and keeps printing
        for everything already mapped to it. Both are future-only, like the wording above — no
        cover that already exists changes until it is rebuilt.
      </p>

      <div className="mt-6 space-y-3">
        {shown.map((r) => (
          <div
            key={r.key}
            className={`rounded-lg border bg-white p-4 ${
              r.active ? "border-zinc-200" : "border-dashed border-zinc-300 opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={r.label}
                placeholder="Row name, e.g. Inlay card"
                onChange={(e) => patch(r.key, { label: e.target.value })}
                className="min-w-[14rem] flex-1 rounded border border-zinc-200 px-2 py-1.5 text-[13px] font-medium text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
              />
              <label className="flex items-center gap-2 text-[13px] text-zinc-600">
                <input
                  type="checkbox"
                  checked={!r.artwork}
                  // Becoming a packing instruction clears the by-hand flag with
                  // it: there is no file for anybody to supply, so leaving it
                  // set would show a tick the server is about to throw away.
                  onChange={(e) =>
                    patch(
                      r.key,
                      e.target.checked
                        ? { artwork: false, alwaysManual: false }
                        : { artwork: true },
                    )
                  }
                />
                Packing instruction — no file, so no delivery status
              </label>
              {r.builtIn && (
                <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-500">
                  built in
                </span>
              )}
              {/* Deliberately NOT the dashed/faded styling a removed row gets:
                  the two states are different things, and looking alike is how
                  a person conflates them. */}
              {!r.printOnCover && (
                <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                  hidden from covers
                </span>
              )}
              <button
                type="button"
                onClick={() => patch(r.key, { active: !r.active })}
                className="ml-auto rounded border border-zinc-300 px-2 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50"
              >
                {r.active ? "Remove" : "Restore"}
              </button>
            </div>

            {!r.active && (
              <p className="mt-2 text-[12px] text-zinc-500">
                Removed — it stops being offered for new mappings. Trim values already pointing at
                it keep printing this row and its wording, so nothing on a cover changes until they
                are re-mapped. To stop it printing, untick <strong>Print on the cover</strong>{" "}
                below instead.
              </p>
            )}

            {/* WHO SUPPLIES IT, and WHETHER IT PRINTS. Two decisions about the
                kind of packaging itself, kept together and away from the
                wording boxes, which are about what the cover says once it does
                print. */}
            <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-zinc-100 pt-3">
              <div className="min-w-[17rem] flex-1">
                <label
                  className={`flex items-center gap-2 text-[13px] ${
                    r.artwork ? "text-zinc-600" : "text-zinc-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={r.artwork && r.alwaysManual}
                    disabled={!r.artwork}
                    onChange={(e) => patch(r.key, { alwaysManual: e.target.checked })}
                  />
                  Always supplied by hand
                </label>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {r.artwork ? (
                    <>
                      The buyer sends us this artwork. The line stays a manual upload — and keeps
                      its drop zone on the style&rsquo;s Review tab — even if a layout starts
                      producing it. Without this, manual is only what a line falls back to when no
                      layout answers it, so adding one would quietly take the drop zone away.
                      Anything we do produce is still listed, under its own name.
                    </>
                  ) : (
                    <>
                      Not available on a packing instruction: there is no file for anyone to supply.
                      Untick <strong>Packing instruction</strong> above first.
                    </>
                  )}
                </p>
              </div>
              <div className="min-w-[17rem] flex-1">
                <label className="flex items-center gap-2 text-[13px] text-zinc-600">
                  <input
                    type="checkbox"
                    checked={r.printOnCover}
                    onChange={(e) => patch(r.key, { printOnCover: e.target.checked })}
                  />
                  Print on the cover
                </label>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  Off hides this <em>kind of packaging</em> wherever it comes from — no line, no
                  status, no drop zone — however Monday words it, and including documents we
                  generate ourselves. Taking a value off the row below hides <em>one Monday word</em>{" "}
                  instead.
                </p>
                {/* The retroactive question, asked at the control rather than
                    in the preamble, because THIS is the tick that reads like a
                    delete — untick it and it is natural to assume the line has
                    just come off the covers in the suppliers' folders. It has
                    not, and it never will until those covers are rebuilt. */}
                <p className="mt-1 text-[11px] text-zinc-500">
                  <strong className="font-medium text-zinc-700">
                    Nothing already delivered changes.
                  </strong>{" "}
                  Hiding a row takes effect on bundles generated from here on; covers already in a
                  supplier&rsquo;s folder keep this line until they are rebuilt.
                </p>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              <Field label="Note">
                <input
                  type="text"
                  value={r.note ?? ""}
                  placeholder="No note"
                  onChange={(e) => patch(r.key, { note: e.target.value })}
                  className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                />
              </Field>
              {r.artwork ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="Not yet delivered">
                    <input
                      type="text"
                      value={r.pending ?? ""}
                      placeholder={DEFAULT_PENDING_STATUS}
                      onChange={(e) => patch(r.key, { pending: e.target.value })}
                      className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                    />
                  </Field>
                  <Field label="Delivered">
                    <input
                      type="text"
                      value={r.delivered ?? ""}
                      placeholder={DEFAULT_DELIVERED_STATUS}
                      onChange={(e) => patch(r.key, { delivered: e.target.value })}
                      className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                    />
                  </Field>
                </div>
              ) : (
                <p className="text-[12px] text-zinc-400">
                  No status boxes: nothing is ever delivered for a packing instruction, so a status
                  would sit at &ldquo;waiting&rdquo; forever.
                </p>
              )}
            </div>

            <TrimValuesForRow
              rowValue={r.value}
              rowLabel={rowLabel}
              labels={labels}
              overrides={overrides}
              state={vocabState}
              onChange={(next) => {
                setSaved(false);
                setOverrides(next);
              }}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addRow}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Add a row
        </button>
        {removedCount > 0 && (
          <label className="flex items-center gap-2 text-[13px] text-zinc-500">
            <input
              type="checkbox"
              checked={showRemoved}
              onChange={(e) => setShowRemoved(e.target.checked)}
            />
            Show {removedCount} removed row{removedCount === 1 ? "" : "s"}
          </label>
        )}
        <div className="ml-auto flex items-center gap-3">
          {saved ? <span className="text-[13px] text-emerald-700">Saved</span> : null}
          {error ? <span className="text-[13px] text-red-600">{error}</span> : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {saving ? "Saving…" : "Save rows"}
          </button>
        </div>
      </div>

      {/* WHAT THIS SCREEN ACTUALLY PRODUCES, and the two things a person needs
          once they have edited it: see it, and — if it matters today — apply
          it. Both already existed elsewhere; neither was reachable from here,
          which is how a wording change gets made and then quietly doubted.
          Deliberately BELOW the rows: the order of the screen is edit, save,
          look, and only then rebuild. */}
      <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-zinc-800">See it on a real cover</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
          The rows above are a list; the cover is a page. This renders one, for a real style, so the
          lines, the wording and the statuses can be read where they will actually be read.
        </p>

        <div className="mt-4">
          <CoverSamplePdf
            inputId="packaging-sample-style"
            lead={
              <>
                Renders that style&rsquo;s actual cover with these packaging rows &mdash; their
                wording, and whichever of them this style&rsquo;s Monday trims land on &mdash;
                folded in.
              </>
            }
            unsavedNote={
              // The render happens server-side from the stored rows, so an
              // unsaved edit is simply not in it. Said plainly, and only while
              // it is true, rather than invented as a draft-rendering path: a
              // preview that took a different route to the page would stop
              // being evidence about the real one.
              dirty ? (
                <>
                  <strong className="font-medium">You have unsaved changes.</strong> The sample is
                  rendered from the saved rows, so press <em>Save rows</em> first if you want to see
                  the edits above in it.
                </>
              ) : null
            }
          />
        </div>

        {/* The manual rebuild. It lives on the General information tab because
            that is where people came looking for it, but the cover is ONE PDF —
            it rebuilds the packaging list too. Linking rather than duplicating:
            a second copy of a control that overwrites suppliers' files is a
            second place for it to drift. */}
        <p className="mt-4 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
          <strong className="font-medium text-zinc-800">
            Editing these rows changes nothing that already exists.
          </strong>{" "}
          Saving applies to bundles generated from now on; every cover already sitting in a
          supplier&rsquo;s folder keeps the lines and words it was built with. To correct one now,
          use{" "}
          <Link
            href="/settings/cover-page?tab=general-info#regenerate-a-style"
            className="font-medium text-zinc-700 underline underline-offset-2"
          >
            Regenerate a style
          </Link>{" "}
          on the <strong>General information</strong> tab — the cover is a single PDF, so it rebuilds
          the packaging list along with everything else on it.
        </p>
      </div>
    </div>
  );
}

// The Monday trim values landing on ONE row.
//
// Reads and writes the shared override record through the pure helpers in
// src/lib/trims/row-bindings.ts — this component holds no mapping of its own.
//
// TWO THINGS IT HAS TO SAY OUT LOUD, because both are ways a person gets
// surprised by a cover a week later:
//   * a value that also lands on ANOTHER row. Legitimate — a compound entry
//     like "Hanger & Hangtag" names two things — but it has to be visible from
//     here, or mapping a value onto this row looks like moving it here.
//   * removing the LAST row from a value. That is the stored "not packaging"
//     decision: the value stops printing on covers altogether. Deleting the
//     stored key instead would hand it straight back to the keyword rule that
//     put it on this row, and the removal would appear not to have worked.
function TrimValuesForRow({
  rowValue,
  rowLabel,
  labels,
  overrides,
  state,
  onChange,
}: {
  rowValue: string;
  rowLabel: Map<string, string>;
  labels: BindableLabel[] | null;
  overrides: TrimLabelOverrides | null;
  state: "loading" | "ready" | "failed";
  onChange: (next: TrimLabelOverrides) => void;
}) {
  const [adding, setAdding] = useState("");

  // A row minted in this session has no id yet, so nothing can point at it.
  if (!rowValue) {
    return (
      <p className="mt-3 border-t border-zinc-100 pt-3 text-[12px] text-zinc-400">
        Save the row first — a Monday value can only be pointed at a row that exists.
      </p>
    );
  }
  if (state === "loading" || !labels || !overrides) {
    return (
      <p className="mt-3 border-t border-zinc-100 pt-3 text-[12px] text-zinc-400">
        {state === "failed"
          ? "The survey of live Monday values could not be read, so mapping is unavailable here. Settings › Trims still works."
          : "Reading the Monday trim values…"}
      </p>
    );
  }

  const bound = labelsBoundToRow(overrides, labels, rowValue);
  const boundKeys = new Set(bound.map((l) => l.normalized));
  // Offer everything not already here, most-used first — the values that matter
  // are the ones a person should not have to scroll for.
  const offerable = labels
    .filter((l) => !boundKeys.has(l.normalized))
    .sort((a, b) => b.styles - a.styles || a.label.localeCompare(b.label));

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-400">
        Monday trim values on this row
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {bound.map((l) => {
          const elsewhere = otherRowsForLabel(overrides, l, rowValue);
          const wouldSuppress = unbindingWouldSuppress(overrides, l, rowValue);
          return (
            <span
              key={l.normalized}
              className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[12px] text-zinc-700"
              title={
                wouldSuppress
                  ? "This row is the only one it lands on — removing it keeps the value off covers entirely."
                  : undefined
              }
            >
              {l.label}
              <span className="tabular-nums text-zinc-400">{l.styles.toLocaleString()}</span>
              {elsewhere.length > 0 && (
                <span className="text-zinc-400">
                  · also on {elsewhere.map((c) => rowLabel.get(c) ?? c).join(", ")}
                </span>
              )}
              <button
                type="button"
                onClick={() => onChange(unbindLabelFromRow(overrides, l, rowValue))}
                className="text-zinc-400 hover:text-red-600"
                aria-label={`Remove ${l.label} from this row`}
              >
                ×
              </button>
            </span>
          );
        })}
        <select
          value={adding}
          onChange={(e) => {
            const picked = labels.find((l) => l.normalized === e.target.value);
            setAdding("");
            if (picked) onChange(bindLabelToRow(overrides, picked, rowValue));
          }}
          className="rounded border border-zinc-300 px-2 py-1 text-[12px]"
        >
          <option value="">Add a Monday value…</option>
          {offerable.map((l) => {
            const on = otherRowsForLabel(overrides, l, rowValue);
            return (
              <option key={l.normalized} value={l.normalized}>
                {l.label} · {l.styles.toLocaleString()} styles
                {on.length > 0 ? ` · on ${on.map((c) => rowLabel.get(c) ?? c).join(", ")}` : ""}
              </option>
            );
          })}
        </select>
      </div>
      {bound.some((l) => unbindingWouldSuppress(overrides, l, rowValue)) && (
        <p className="mt-1 text-[11px] text-zinc-400">
          A value this row is the only home for stops printing on covers entirely when it is removed
          here — that is the same &ldquo;not packaging&rdquo; decision Settings › Trims offers.
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

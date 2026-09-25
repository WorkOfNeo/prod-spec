"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  normalizeCustomerCopy,
  type TrimConceptRow,
  type TrimCustomerCopy,
} from "@/lib/trims/concepts";
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
// -----------------------------------------------------------------------------
// ONE ROW IS ONE ACCORDION, AND IT IS CLOSED BY DEFAULT.
//
// Every row carries a name, two ticks, three wording boxes, its per-customer
// wording and its Monday values — call it twenty controls, times twenty-one
// rows. Laid out flat that is a page nobody can scan, and the thing a person
// actually arrives wanting ("what does the Banderole line say?") is buried
// among four hundred controls belonging to other rows. So a closed row is a
// one-line SUMMARY of every decision on it — packing instruction, hidden,
// always by hand, how many customers have their own wording, how many Monday
// values land here — and opening one is how you edit it. The summary is built
// from the same draft the body edits, so it can never describe a stale row.
//
// EDITS SAVE THEMSELVES. There is no Save button, because with twenty-one
// collapsed rows a Save button is a way to lose work: you open a row, fix a
// sentence, collapse it, open another, and the first edit is now invisible and
// unsaved. A debounce after the last keystroke writes it.
//
// "IF NOT CAUSING ANY ISSUES" IS DOING WORK IN THAT SENTENCE, and it is why a
// NEW row is the one thing that does not autosave. A row's id is minted from
// its NAME the first time it is stored and can never be rewritten afterwards
// (see concepts.ts — every trim mapping and layout pin points at it), so an
// autosave firing mid-word would permanently mint INL for a row called "Inlay
// card". A new row therefore stays local until its name is confirmed once.
// Everything after that — including renaming it — autosaves freely, because
// the id is already fixed and the name is just words on a page.
//
// AND THE SAVE IS PREDICTED, NOT READ BACK. The server normalises what it
// stores (it strips a packing instruction's status wording, drops an override
// naming nobody), so a naive autosave would have to repaint from the response
// and would yank the text out from under whatever is being typed. Instead the
// editor computes the EXACT payload the server will store, using the same pure
// normaliser the server uses, and compares against that. Nothing is repainted
// except on the one path where the server knows something the client cannot:
// the id it just minted for a new row.
// -----------------------------------------------------------------------------
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

export type CustomerOption = { id: string; name: string };

type Props = {
  initialRows: TrimConceptRow[];
  // The master switch, read on the server beside the rows. While it is OFF
  // there is no trim context at all, so nothing configured on this screen —
  // wording, always-by-hand, hidden — reaches a single cover, and a person
  // editing here deserves to be told that before they wonder why hiding a row
  // did nothing. It is a fact stated, not a control: flipping it lives on the
  // Cover page tab, next to the preview that justifies flipping it.
  trimsEnabled: boolean;
  // Every active customer, for the per-row status-wording overrides. Names are
  // resolved from this list at render; an override storing an id this list has
  // no name for still shows (as the raw id) rather than disappearing, because
  // the words it carries are real whatever happened to the customer.
  customers: CustomerOption[];
};

type Draft = TrimConceptRow & {
  // Client-only key: a brand-new row has no id until the server mints one from
  // its label, and React still needs something stable to render it by.
  key: string;
};

const toDraft = (row: TrimConceptRow): Draft => ({ ...row, key: row.value });

// The row as the server will store it. Everything the editor sends goes through
// here first, so what the dirty check compares is what the table will hold —
// see the header on why the save is predicted rather than read back.
type RowPayload = ReturnType<typeof rowPayload>;
function rowPayload(r: Draft, index: number) {
  const artwork = r.artwork;
  return {
    ...(r.value ? { value: r.value } : {}),
    label: r.label.trim(),
    artwork,
    note: r.note?.trim() ?? "",
    // Mirrors normalizeTrimConceptRows: a packing instruction stores no
    // delivery state, in any of its three forms. Sent anyway (as empty), so
    // ticking the box CLEARS wording a row already had rather than leaving it
    // in the table where the next untick would resurrect it.
    pending: artwork ? (r.pending?.trim() ?? "") : "",
    delivered: artwork ? (r.delivered?.trim() ?? "") : "",
    alwaysManual: artwork && r.alwaysManual,
    printOnCover: r.printOnCover,
    customerCopy: artwork ? normalizeCustomerCopy(r.customerCopy) : [],
    sortOrder: (index + 1) * 10,
    active: r.active,
  };
}

// A row with no name cannot be stored (normalizeTrimConceptRows drops it), so
// it is not part of what the dirty check is comparing either.
const payloadFor = (rows: Draft[]): RowPayload[] =>
  rows.filter((r) => r.label.trim() !== "").map(rowPayload);

type SaveState = "idle" | "saving" | "saved" | "error";

export function PackagingRowsEditor({ initialRows, trimsEnabled, customers }: Props) {
  const [rows, setRows] = useState<Draft[]>(() => initialRows.map(toDraft));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  // Which rows are expanded. Closed by default and NOT persisted: the list is
  // read far more often than it is edited, and a screen that reopened whatever
  // was last touched would greet the next person with somebody else's row.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  // The trim mapping, held exactly as it is stored: normalised value -> row ids.
  // `null` until the census answers, which is what tells the pickers to say
  // "loading" rather than "no values on this row yet" — the second is a claim,
  // and it would be a false one.
  const [overrides, setOverrides] = useState<TrimLabelOverrides | null>(null);
  const [labels, setLabels] = useState<BindableLabel[] | null>(null);
  const [vocabState, setVocabState] = useState<"loading" | "ready" | "failed">("loading");
  // What is actually stored, as last read or last written. Held separately from
  // `overrides` (the edited copy) because the mapping is a DIFFERENT store with
  // its own endpoint — one autosave writes both.
  const [savedOverrides, setSavedOverrides] = useState<TrimLabelOverrides | null>(null);

  const customerName = useMemo(
    () => new Map(customers.map((c) => [c.id, c.name])),
    [customers],
  );

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

  // The stored baseline for the ROWS half, as JSON of the normalised payload.
  // Moved forward only by a successful write, so a failed save leaves the
  // screen dirty and the debounce retries on the next keystroke. STATE rather
  // than a ref because the dirty flag derived from it drives the render — the
  // save indicator, the disabled states and the sample panel's warning all
  // read it — and a ref read during render is a value React has not agreed to
  // re-render for.
  const [savedRowsJson, setSavedRowsJson] = useState(() =>
    JSON.stringify(payloadFor(initialRows.map(toDraft))),
  );

  const rowsJson = useMemo(() => JSON.stringify(payloadFor(rows)), [rows]);
  const rowsDirty = rowsJson !== savedRowsJson;
  const mappingDirty =
    overrides !== null &&
    savedOverrides !== null &&
    JSON.stringify(overrides) !== JSON.stringify(savedOverrides);
  const dirty = rowsDirty || mappingDirty;

  // Row id -> its name, for "also on Hangtag" beside a value that lands on
  // several. Every row resolves, removed ones included: a value can still point
  // at a retired row, and printing a raw id there would look like corruption.
  const rowLabel = useMemo(
    () => new Map(rows.filter((r) => r.value).map((r) => [r.value, r.label.trim() || r.value])),
    [rows],
  );

  const patch = useCallback((key: string, change: Partial<Draft>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }, []);

  // ---------------------------------------------------------------------------
  // THE WRITE. Two endpoints, one call, and the mapping goes FIRST because it
  // can only ever name rows that already have an id — so it is never the write
  // that depends on the other one landing. Each is atomic for its own store; if
  // the second fails the first stands and the screen stays dirty for the half
  // that did not save, which is the honest outcome. Inventing a transaction
  // across two settings stores to protect an edit the next keystroke retries is
  // not worth it.
  //
  // `flush` closes over the CURRENT draft and is therefore a new function on
  // every keystroke — which is what the debounce below wants, since its
  // cleanup cancels the previous timer and schedules a fresh one. The only
  // thing that needs the latest version out-of-band is the retry at the bottom
  // of the request, and that reads it from a ref written in an effect.
  // ---------------------------------------------------------------------------
  const inFlight = useRef(false);
  const rerun = useRef(false);

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      // A save landed while another was still in the air. Remembering to go
      // again is what keeps the LAST keystroke stored rather than the one that
      // happened to be in the request.
      rerun.current = true;
      return;
    }
    const mapNeedsWrite =
      overrides !== null &&
      savedOverrides !== null &&
      JSON.stringify(overrides) !== JSON.stringify(savedOverrides);
    const rowsNeedWrite = rowsJson !== savedRowsJson;
    if (!rowsNeedWrite && !mapNeedsWrite) return;

    inFlight.current = true;
    setSaveState("saving");
    setError(null);
    try {
      if (mapNeedsWrite && overrides) {
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
      if (rowsNeedWrite) {
        const res = await fetch("/api/admin/settings/cover-page/packaging-rows", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // rowsJson IS the payload, already normalised — sent verbatim so the
          // baseline recorded below cannot describe a different request than
          // the one that went out.
          body: `{"rows":${rowsJson}}`,
        });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
        }
        // Deliberately NOT repainted from the response. The payload above is
        // already what the server stores — same normaliser, run client-side —
        // so a repaint would gain nothing and would overwrite whatever has been
        // typed since the request left. The one thing only the server knows,
        // the id it mints for a NEW row, is handled by `createRow` instead,
        // which is why a new row does not travel this path.
        await res.json().catch(() => null);
        setSavedRowsJson(rowsJson);
      }
      setSaveState("saved");
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      inFlight.current = false;
      if (rerun.current) {
        rerun.current = false;
        // The LATEST flush, not this one: this closure holds the draft as it
        // was when the request left, and the whole point of the retry is to
        // store what has been typed since.
        void flushRef.current();
      }
    }
  }, [rowsJson, savedRowsJson, overrides, savedOverrides]);

  // Refs written in an effect rather than during render — the retry above and
  // the unmount flush below both run outside render and need the current
  // values, which is exactly what a ref is for.
  const flushRef = useRef(flush);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    flushRef.current = flush;
    dirtyRef.current = dirty;
  }, [flush, dirty]);

  // Debounced autosave. 800ms is the same beat the cover-page markdown editor
  // next door uses, so the two screens feel like one app.
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(() => void flush(), 800);
    return () => window.clearTimeout(t);
  }, [dirty, flush]);

  // A pending debounce must not be lost to a navigation. The listener is the
  // browser's own guard for the case where the tab is closing and a fetch would
  // not finish; the unmount flush covers an in-app route change, which is the
  // common one. Mounted once, so it reads both values from the refs above.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (dirtyRef.current) void flushRef.current();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // ADDING A ROW. The one write that is NOT an autosave, because the id minted
  // here is permanent (see the header): a debounce firing on "Inl" would name
  // the row INL forever. So the new row is local until its name is confirmed,
  // and this is the only path that repaints from the server — it has to, since
  // the id is the one thing the client cannot compute.
  // ---------------------------------------------------------------------------
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const createRow = useCallback(async () => {
    const label = newLabel.trim();
    if (!label || creating) return;
    setCreating(true);
    setError(null);
    try {
      // Everything currently on screen plus the new row, so a create never
      // rolls back an edit the debounce has not written yet.
      const known = new Set(rows.map((r) => r.value).filter(Boolean));
      const payload = [
        ...payloadFor(rows),
        {
          label,
          artwork: true,
          note: "",
          pending: "",
          delivered: "",
          alwaysManual: false,
          printOnCover: true,
          customerCopy: [] as TrimCustomerCopy[],
          sortOrder: (rows.length + 1) * 10,
          active: true,
        },
      ];
      const res = await fetch("/api/admin/settings/cover-page/packaging-rows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
      }
      const body = (await res.json()) as { rows?: TrimConceptRow[] };
      const stored = body.rows ?? [];
      setRows(stored.map(toDraft));
      setSavedRowsJson(JSON.stringify(payloadFor(stored.map(toDraft))));
      setNewLabel("");
      setSaveState("saved");
      setSavedAt(new Date().toLocaleTimeString());
      // Open the row that was just created, so the next thing a person does —
      // write its wording — needs no second click to reach.
      const minted = stored.find((r) => !known.has(r.value));
      if (minted) setOpen((prev) => new Set(prev).add(minted.value));
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : "Could not add the row");
    } finally {
      setCreating(false);
    }
  }, [newLabel, creating, rows]);

  const removedCount = rows.filter((r) => !r.active).length;
  const shown = showRemoved ? rows : rows.filter((r) => r.active);

  const status =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? (error ?? "Could not save")
        : dirty
          ? "Unsaved…"
          : savedAt
            ? `Saved · ${savedAt}`
            : "Saves as you type";

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
        Open a row to edit it. The <strong>note</strong> is a standing fact about the document and
        prints in every state; the two status boxes are what the Status column says while the
        artwork is still to come, and once it is confirmed. Leave a box empty to use the wording
        shown greyed inside it, and give a named client its own words under{" "}
        <strong>custom delivery text</strong>. Changes apply to <strong>newly generated</strong>{" "}
        bundles — covers already in a supplier&rsquo;s folder keep their words until they are
        rebuilt.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        Each row also decides two things about the packaging itself:{" "}
        <strong>always supplied by hand</strong> keeps the line an upload even once a layout
        produces it, and <strong>print on the cover</strong> decides whether the row appears at all.
        Neither is <em>Remove</em>: a removed row is only retired from this list and keeps printing
        for everything already mapped to it. Both are future-only, like the wording above — no
        cover that already exists changes until it is rebuilt.
      </p>

      {/* The save indicator lives at the TOP as well as the bottom, because a
          collapsed row can be edited and closed without the bottom of the page
          ever being on screen. */}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-b border-zinc-200 pb-2">
        <span className="text-[13px] font-medium text-zinc-700">
          {shown.length} row{shown.length === 1 ? "" : "s"}
        </span>
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
          <button
            type="button"
            onClick={() => setOpen(new Set(shown.map((r) => r.key)))}
            className="text-[12px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setOpen(new Set())}
            className="text-[12px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800"
          >
            Collapse all
          </button>
          <span
            role="status"
            className={`text-[13px] ${
              saveState === "error"
                ? "text-red-600"
                : saveState === "saved" && !dirty
                  ? "text-emerald-700"
                  : "text-zinc-400"
            }`}
          >
            {status}
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {shown.map((r) => (
          <RowAccordion
            key={r.key}
            row={r}
            open={open.has(r.key)}
            onToggle={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(r.key)) next.delete(r.key);
                else next.add(r.key);
                return next;
              })
            }
            patch={patch}
            customers={customers}
            customerName={customerName}
            rowLabel={rowLabel}
            labels={labels}
            overrides={overrides}
            vocabState={vocabState}
            onMappingChange={setOverrides}
          />
        ))}
      </div>

      {/* ADDING A ROW, deliberately its own little form rather than an empty
          card appended to the list. The name typed here becomes the row's
          permanent id, so it is confirmed ONCE, on purpose, instead of being
          minted by a debounce firing mid-word. Everything afterwards — the
          wording, the ticks, even renaming it — autosaves. */}
      <div className="mt-4 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 p-4">
        <span className="text-[13px] font-medium text-zinc-700">Add a row</span>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newLabel}
            placeholder="Row name, e.g. Inlay card"
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void createRow();
              }
            }}
            className="min-w-[16rem] flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void createRow()}
            disabled={creating || newLabel.trim() === ""}
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {creating ? "Adding…" : "Create row"}
          </button>
        </div>
        <p className="mt-2 max-w-3xl text-[11px] text-zinc-500">
          The name becomes this row&rsquo;s permanent id, which every trim mapping and layout pin
          then points at — so it is created once, here, rather than as you type. You can rename the
          row afterwards as often as you like: the id stays put, and nothing mapped to it comes
          loose.
        </p>
      </div>

      {/* WHAT THIS SCREEN ACTUALLY PRODUCES, and the two things a person needs
          once they have edited it: see it, and — if it matters today — apply
          it. Both already existed elsewhere; neither was reachable from here,
          which is how a wording change gets made and then quietly doubted.
          Deliberately BELOW the rows: the order of the screen is edit, look,
          and only then rebuild. */}
      <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-zinc-800">See it on a real cover</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
          The rows above are a list; the cover is a page. This renders one, for a real style, so the
          lines, the wording and the statuses can be read where they will actually be read — the
          custom text included, since the style names the client it belongs to.
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
              // The render happens server-side from the stored rows, so an edit
              // the debounce has not written yet is simply not in it. Said
              // plainly, and only while it is true, rather than invented as a
              // draft-rendering path: a preview that took a different route to
              // the page would stop being evidence about the real one.
              dirty ? (
                <>
                  <strong className="font-medium">An edit is still saving.</strong> The sample is
                  rendered from the saved rows — give it a moment and render again to see the edits
                  above in it.
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

// ---------------------------------------------------------------------------
// ONE ROW.
//
// Closed, it is a summary of every decision on the row. That is the whole
// reason the accordion is worth having: twenty-one rows of twenty controls is
// not a list anybody can read, and a header that only showed the name would
// force a person to open every row to find the one that is hidden, or the one
// with custom wording for the client they are asking about.
// ---------------------------------------------------------------------------
function RowAccordion({
  row: r,
  open,
  onToggle,
  patch,
  customers,
  customerName,
  rowLabel,
  labels,
  overrides,
  vocabState,
  onMappingChange,
}: {
  row: Draft;
  open: boolean;
  onToggle: () => void;
  patch: (key: string, change: Partial<Draft>) => void;
  customers: CustomerOption[];
  customerName: Map<string, string>;
  rowLabel: Map<string, string>;
  labels: BindableLabel[] | null;
  overrides: TrimLabelOverrides | null;
  vocabState: "loading" | "ready" | "failed";
  onMappingChange: (next: TrimLabelOverrides) => void;
}) {
  const boundCount =
    overrides && labels && r.value ? labelsBoundToRow(overrides, labels, r.value).length : null;
  const customCount = r.artwork ? normalizeCustomerCopy(r.customerCopy).length : 0;

  return (
    <div
      className={`rounded-lg border bg-white ${
        r.active ? "border-zinc-200" : "border-dashed border-zinc-300 opacity-60"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left"
      >
        <span
          aria-hidden
          className={`text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        <span className="text-[13px] font-medium text-zinc-800">
          {r.label.trim() || <span className="text-zinc-300">Unnamed row</span>}
        </span>
        {/* Every decision on the row, in one line. Each badge is present only
            when it is NOT the neutral value, so a plain row stays plain and the
            ones that have been configured are the ones that catch the eye. */}
        {!r.artwork && <Badge tone="zinc">packing instruction</Badge>}
        {r.artwork && r.alwaysManual && <Badge tone="zinc">always by hand</Badge>}
        {!r.printOnCover && <Badge tone="amber">hidden from covers</Badge>}
        {customCount > 0 && (
          <Badge tone="sky">
            custom text · {customCount} {customCount === 1 ? "entry" : "entries"}
          </Badge>
        )}
        {!r.active && <Badge tone="zinc">removed</Badge>}
        {r.builtIn && <Badge tone="zinc">built in</Badge>}
        <span className="ml-auto text-[11px] text-zinc-400">
          {boundCount === null
            ? ""
            : `${boundCount} Monday value${boundCount === 1 ? "" : "s"}`}
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-100 px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="min-w-[14rem] flex-1">
              <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-zinc-400">
                Row name
              </span>
              <input
                type="text"
                value={r.label}
                placeholder="Row name, e.g. Inlay card"
                onChange={(e) => patch(r.key, { label: e.target.value })}
                className="w-full rounded border border-zinc-200 px-2 py-1.5 text-[13px] font-medium text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 pt-4 text-[13px] text-zinc-600">
              <input
                type="checkbox"
                checked={!r.artwork}
                // Becoming a packing instruction clears the by-hand flag with
                // it: there is no file for anybody to supply, so leaving it
                // set would show a tick the server is about to throw away.
                onChange={(e) =>
                  patch(
                    r.key,
                    e.target.checked ? { artwork: false, alwaysManual: false } : { artwork: true },
                  )
                }
              />
              Packing instruction — no file, so no delivery status
            </label>
            <button
              type="button"
              onClick={() => patch(r.key, { active: !r.active })}
              className="ml-auto mt-4 rounded border border-zinc-300 px-2 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50"
            >
              {r.active ? "Remove" : "Restore"}
            </button>
          </div>

          {!r.active && (
            <p className="mt-2 text-[12px] text-zinc-500">
              Removed — it stops being offered for new mappings. Trim values already pointing at it
              keep printing this row and its wording, so nothing on a cover changes until they are
              re-mapped. To stop it printing, untick <strong>Print on the cover</strong> below
              instead.
            </p>
          )}

          {/* WHO SUPPLIES IT, and WHETHER IT PRINTS. Two decisions about the
              kind of packaging itself, kept together and away from the wording
              boxes, which are about what the cover says once it does print. */}
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
                    The buyer sends us this artwork. The line stays a manual upload — and keeps its
                    drop zone on the style&rsquo;s Review tab — even if a layout starts producing
                    it. Without this, manual is only what a line falls back to when no layout
                    answers it, so adding one would quietly take the drop zone away. Anything we do
                    produce is still listed, under its own name.
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
                status, no drop zone — however Monday words it, and including documents we generate
                ourselves. Taking a value off the row below hides <em>one Monday word</em> instead.
              </p>
              {/* The retroactive question, asked at the control rather than in
                  the preamble, because THIS is the tick that reads like a
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

          {r.artwork && (
            <CustomerCopyForRow
              row={r}
              customers={customers}
              customerName={customerName}
              onChange={(next) => patch(r.key, { customerCopy: next })}
            />
          )}

          <TrimValuesForRow
            rowValue={r.value}
            rowLabel={rowLabel}
            labels={labels}
            overrides={overrides}
            state={vocabState}
            onChange={onMappingChange}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CUSTOM DELIVERY TEXT: the two status sentences, rewritten for named clients.
//
// WHAT IT IS AND WHAT IT DELIBERATELY IS NOT. The row above is global on
// purpose — a "Care label" per client is the per-client layout mapping again,
// and it would have to be redone for every client we take on (see
// src/lib/trims/concepts.ts). Nothing here changes that: the row's name, its
// kind, whether it prints and whether we draw it stay one answer for everybody.
// The only thing that varies is the two SENTENCES, because those are genuinely
// about the buyer — a Netto banderole is waited on differently from anyone
// else's, and that is a fact about Netto, not about banderoles.
//
// ONE ENTRY, SEVERAL CLIENTS. The same sentence usually covers a handful of
// them at once, and typing it three times is three places for it to drift —
// which is the argument the whole concept layer is built on, applied one level
// down. So an entry names a LIST of clients.
//
// A CLIENT APPEARS IN AT MOST ONE ENTRY, and the picker enforces it rather than
// letting two entries fight. The resolver takes the first entry naming a client
// (customerTrimCopy), so a second naming would be wording a person can see on
// this screen and will never find on a cover — the worst kind of setting.
//
// EACH BOX FALLS BACK ON ITS OWN. Filling only "not yet delivered" leaves
// "delivered" reading the row's own wording, not a blank — the placeholder says
// so, and resolveTrimCopy does it field by field for exactly this reason.
// ---------------------------------------------------------------------------
function CustomerCopyForRow({
  row,
  customers,
  customerName,
  onChange,
}: {
  row: Draft;
  customers: CustomerOption[];
  customerName: Map<string, string>;
  onChange: (next: TrimCustomerCopy[]) => void;
}) {
  // Memoised so the claim map below is not rebuilt on every unrelated render
  // of the row — `?? []` is a new array each time otherwise.
  const entries = useMemo(() => row.customerCopy ?? [], [row.customerCopy]);
  // Claimed elsewhere on THIS row — the picker offers a client once, so two
  // entries can never both name it and one of them be silently unreachable.
  const claimed = useMemo(() => {
    const out = new Map<string, number>();
    entries.forEach((e, i) => {
      for (const id of e.customerIds ?? []) if (!out.has(id)) out.set(id, i);
    });
    return out;
  }, [entries]);

  const patchEntry = (index: number, change: Partial<TrimCustomerCopy>) =>
    onChange(entries.map((e, i) => (i === index ? { ...e, ...change } : e)));

  // The fallback each box shows greyed: the row's own wording where it has one,
  // and the house default where it does not. Shown rather than described,
  // because "leave it empty for the default" is only useful if you can see what
  // the default says.
  const pendingFallback = row.pending?.trim() || DEFAULT_PENDING_STATUS;
  const deliveredFallback = row.delivered?.trim() || DEFAULT_DELIVERED_STATUS;

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-400">
        Custom delivery text for named clients
      </span>
      <p className="mb-2 max-w-3xl text-[11px] text-zinc-400">
        Everything else about this row stays the same for everybody — only these two sentences
        change, and only for the clients named here. Every other client reads the wording above. A
        box left empty falls back to that wording on its own, so writing just one of the two is
        fine. A client can appear in one entry only.
      </p>

      <div className="space-y-2">
        {entries.map((entry, i) => {
          const ids = entry.customerIds ?? [];
          const offerable = customers.filter((c) => !claimed.has(c.id));
          const says = (entry.pending?.trim() ?? "") !== "" || (entry.delivered?.trim() ?? "") !== "";
          return (
            <div key={i} className="rounded border border-zinc-200 bg-zinc-50/60 p-3">
              <div className="flex flex-wrap items-center gap-1">
                {ids.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[12px] text-zinc-700"
                  >
                    {/* A client whose row has gone (renamed away, deactivated)
                        still shows, as its id. The words stored against it are
                        real, and silently dropping the chip would look like the
                        entry had emptied itself. */}
                    {customerName.get(id) ?? id}
                    <button
                      type="button"
                      onClick={() =>
                        patchEntry(i, { customerIds: ids.filter((x) => x !== id) })
                      }
                      className="text-zinc-400 hover:text-red-600"
                      aria-label={`Remove ${customerName.get(id) ?? id} from this custom text`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <select
                  value=""
                  onChange={(e) => {
                    const picked = e.target.value;
                    if (picked) patchEntry(i, { customerIds: [...ids, picked] });
                  }}
                  className="rounded border border-zinc-300 bg-white px-2 py-1 text-[12px]"
                >
                  <option value="">Add a client…</option>
                  {offerable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onChange(entries.filter((_, x) => x !== i))}
                  className="ml-auto rounded border border-zinc-300 bg-white px-2 py-1 text-[12px] text-zinc-600 hover:bg-zinc-50"
                >
                  Delete
                </button>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Not yet delivered">
                  <input
                    type="text"
                    value={entry.pending ?? ""}
                    placeholder={pendingFallback}
                    onChange={(e) => patchEntry(i, { pending: e.target.value })}
                    className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                  />
                </Field>
                <Field label="Delivered">
                  <input
                    type="text"
                    value={entry.delivered ?? ""}
                    placeholder={deliveredFallback}
                    onChange={(e) => patchEntry(i, { delivered: e.target.value })}
                    className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                  />
                </Field>
              </div>

              {/* Both halves of "says nothing" are stated, because an entry in
                  either state is stored as nothing and a person would otherwise
                  come back to find their work gone with no explanation. */}
              {ids.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-700">
                  No client named, so this entry is not saved. Add one, or delete the entry.
                </p>
              )}
              {ids.length > 0 && !says && (
                <p className="mt-1 text-[11px] text-amber-700">
                  Both boxes are empty, so this entry is not saved — an override of nothing is
                  nothing. Write one of the two, or delete the entry.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onChange([...entries, { customerIds: [], pending: "", delivered: "" }])}
        disabled={claimed.size >= customers.length && customers.length > 0}
        className="mt-2 rounded border border-zinc-300 px-2 py-1 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300"
      >
        Add custom text
      </button>
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
          value=""
          onChange={(e) => {
            const picked = labels.find((l) => l.normalized === e.target.value);
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

function Badge({ tone, children }: { tone: "zinc" | "amber" | "sky"; children: React.ReactNode }) {
  const cls =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : tone === "sky"
        ? "border-sky-200 bg-sky-50 text-sky-700"
        : "border-zinc-200 bg-zinc-50 text-zinc-500";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>{children}</span>
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

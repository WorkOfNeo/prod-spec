"use client";

import { useCallback, useState, type ReactNode } from "react";

// "Show me a real one." — type a style number, get that style's ACTUAL cover
// PDF back, rendered through the same builder publish uses.
//
// EXTRACTED, NOT WRITTEN. This box already existed inside the cover tab's
// preview panel; the packaging-rows tab needs exactly the same thing, and the
// one thing worse than no preview on that screen would be a second one that
// renders differently. So there is one component, one endpoint, one renderer —
// only the sentence above it changes with the screen.
//
// WHY IT IS SAFE TO OFFER WHILE THE MASTER SWITCH IS OFF, both properties
// belonging to the route (see src/app/api/admin/settings/cover-page/sample-pdf):
//
//   1. It renders with forceTrims. Deciding whether to turn the switch on is
//      the entire reason to look at a sample, so the sample has to ignore the
//      switch. That bypass stays confined to callers like this one, which hand
//      the bytes straight back to a browser tab.
//   2. It persists NOTHING. No JobAsset, no queue row, no fingerprint, no
//      SharePoint push, no email. Somebody can open a hundred of these and the
//      estate is untouched — which is what makes it a thing to reach for rather
//      than a thing to be careful with.
//
// IT SHOWS SAVED CONFIGURATION. The render happens server-side from what is in
// the database, so an unsaved edit in the form above is not in it. That is said
// on screen (`unsavedNote`) rather than papered over with a draft-rendering
// path: a preview that quietly disagreed with the real builder would be worth
// less than none.

type Props = {
  // The one sentence that differs per screen: what THIS page's edits look like
  // in the sample. The invariants below it are the component's own words, so
  // they cannot drift between the two places this appears.
  lead: ReactNode;
  // Rendered in place of the idle hint while the caller has unsaved changes.
  // Null/undefined ⇒ nothing to say.
  unsavedNote?: ReactNode | null;
  // Distinct per mount so the label always points at its own input.
  inputId: string;
};

export function CoverSamplePdf({ lead, unsavedNote, inputId }: Props) {
  const [styleQuery, setStyleQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch rather than a plain link: a miss returns JSON, and sending someone to
  // a blank tab holding {"error":"No style matches..."} is a worse answer than
  // the message printed under the box. On success the bytes become a blob URL
  // and open in a new tab.
  const open = useCallback(async () => {
    const q = styleQuery.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/settings/cover-page/sample-pdf?style=${encodeURIComponent(q)}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not render a sample (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      // The tab holds its own reference once opened; releasing ours keeps the
      // blob from pinning memory for the rest of the session.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not render a sample");
    } finally {
      setLoading(false);
    }
  }, [styleQuery]);

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="text-[13px] font-medium text-zinc-700">
          Check one style:
        </label>
        <input
          id={inputId}
          value={styleQuery}
          onChange={(e) => setStyleQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void open();
            }
          }}
          placeholder="Style number"
          className="w-52 rounded border border-zinc-300 px-2 py-1.5 text-[13px]"
        />
        <button
          type="button"
          onClick={open}
          disabled={!styleQuery.trim() || loading}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
        >
          {loading ? "Rendering…" : "Open the real cover PDF"}
        </button>
      </div>
      <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-zinc-500">
        {lead} It is rendered by the same builder that produces the real thing, with the trims
        folded in, so it is the page itself and not a preview of one — this is what the cover{" "}
        <strong>would</strong> print once <em>Trims on cover pages</em> is switched on. It is only a
        sample: nothing is saved, nothing is pushed to SharePoint, and no supplier sees it.
      </p>
      {unsavedNote ? (
        <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-amber-700">{unsavedNote}</p>
      ) : null}
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}

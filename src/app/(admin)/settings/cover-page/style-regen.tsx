"use client";

import { useCallback, useMemo, useState } from "react";

// "Regenerate a style" — the narrow companion to the bulk panel below it.
//
// Saving General information changes what is generated FROM NOW ON; bundles
// that already exist keep the text they were built with. The bulk panel fixes
// that for a whole prod spec, which is right after a wording change everyone
// should see and much too broad when a single order needs correcting. This is
// the escape hatch for that case: type the style number, see exactly which
// orders carry it, then rebuild those covers and push them back into the
// suppliers' folders.
//
// FOUR THINGS THIS UI OWES THE PERSON USING IT:
//
//   1. Resolve BEFORE acting. A style number is not unique in this data — one
//      Pre-Order row per PO, two colourways per number — so several matches is
//      ordinary. Every match is named on screen before anything runs.
//   2. Act on ALL of them. Someone correcting a style means the style, not
//      whichever row happened to sort first; making them re-type the number
//      once per order is how one gets missed. So the default is the whole list,
//      with per-row control for the person who genuinely wants a subset.
//   3. Say what will happen, naming the actual orders and suppliers, while the
//      button is still unpressed. This overwrites files in suppliers' folders;
//      that should never be a surprise.
//   4. Report PER STYLE. "Regenerated" and "pushed" are separate facts, either
//      can fail on its own, and with several styles in flight a run where one
//      of four failed must never render as a single green tick.
//
// A style from another client's prod spec is allowed and is NOT silently
// normal: its row is labelled with the spec it belongs to, because that is the
// General information its cover will print — its own, never the open one's.

type Candidate = {
  styleId: string;
  styleName: string;
  customerName: string | null;
  supplierName: string | null;
  poNumber: string | null;
  status: string;
  inThisSpec: boolean;
  prodSpecName: string | null;
  hasCover: boolean;
};

type StyleResult = {
  styleId: string;
  styleName: string | null;
  prodSpecName: string | null;
  inThisSpec: boolean;
  refreshed: boolean;
  outcome: "pushed" | "not-pushed" | "push-failed" | "no-cover" | "not-found" | "error";
  reason: string | null;
  message: string | null;
  requeue: string | null;
  pushed: number;
  pushFailed: number;
  pushError: string | null;
  sharePointStatus: string | null;
  folderUrl: string | null;
  sharePointError: string | null;
};

type RunResponse = {
  results: StyleResult[];
  summary: {
    total: number;
    refreshed: number;
    pushed: number;
    notPushed: number;
    pushFailed: number;
    noCover: number;
    failed: number;
    allSucceeded: boolean;
  };
};

type Phase = "idle" | "resolving" | "plan" | "running" | "done";

// Plain-English reading of enqueueCoverForSupplier's outcome, so "regenerated
// but not pushed" always carries its reason instead of a bare enum.
function requeueNote(requeue: string | null): string {
  switch (requeue) {
    case "not-delivered":
      return "no supplier to deliver to (or the client delivers their own goods)";
    case "no-outputs":
      return "no generated layouts yet, and a cover is never sent to a supplier on its own";
    case "below-cutoff":
      return "below the supplier-send PO cutoff, so nothing is delivered for it";
    case "error":
      return "arming the supplier queue failed";
    default:
      return "supplier batch-send may be switched off — it stays queued until it is on";
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function StyleRegenPanel({
  prodSpecId,
  scopeLabel,
}: {
  prodSpecId: string;
  scopeLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [matches, setMatches] = useState<Candidate[]>([]);
  const [ambiguous, setAmbiguous] = useState(false);
  const [matchedExactly, setMatchedExactly] = useState(true);
  // Which of the matches this run will act on. Everything with a cover, by
  // default — the whole point is that one typed number fixes every order
  // carrying it — but unpickable, so a person with a reason can narrow it.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [notifySupplier, setNotifySupplier] = useState(false);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    async (body: unknown) => {
      const res = await fetch(`/api/admin/prod-specs/${prodSpecId}/general-info/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) throw new Error((parsed?.error as string) ?? `Failed (${res.status})`);
      return parsed ?? {};
    },
    [prodSpecId],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setMatches([]);
    setChosen(new Set());
    setRun(null);
    setError(null);
  }, []);

  const findStyle = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setPhase("resolving");
    setError(null);
    setRun(null);
    try {
      const data = (await post({ mode: "resolve", styleNumber: q })) as {
        matches: Candidate[];
        ambiguous: boolean;
        matchedExactly: boolean;
      };
      setMatches(data.matches);
      setAmbiguous(data.ambiguous);
      setMatchedExactly(data.matchedExactly);
      setChosen(new Set(data.matches.filter((m) => m.hasCover).map((m) => m.styleId)));
      setPhase("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
      setPhase("idle");
    }
  }, [post, query]);

  const selected = useMemo(
    () => matches.filter((m) => chosen.has(m.styleId)),
    [matches, chosen],
  );
  const foreign = useMemo(() => selected.filter((m) => !m.inThisSpec), [selected]);

  const toggle = useCallback((styleId: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(styleId)) next.delete(styleId);
      else next.add(styleId);
      return next;
    });
  }, []);

  const regenerate = useCallback(async () => {
    if (selected.length === 0) return;
    setPhase("running");
    setError(null);
    try {
      const data = (await post({
        mode: "run",
        styleIds: selected.map((m) => m.styleId),
        notifySupplier,
      })) as RunResponse;
      setRun(data);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regenerate failed");
      setPhase("plan");
    }
  }, [post, selected, notifySupplier]);

  return (
    <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-800">Regenerate a style</h2>
      <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
        Fixing one style rather than the whole client? Enter its style number. The same number
        usually covers several orders — one per PO, one per colourway — so every match is listed
        and all of them are corrected together. Each style&rsquo;s cover PDF is rebuilt with the
        General information of the client it belongs to, and pushed back to its supplier&rsquo;s
        SharePoint folder, replacing the copy they have now. Nothing else is touched: no other
        style, no outputs, no approvals.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label htmlFor="gi-regen-style" className="text-[13px] font-medium text-zinc-700">
          Style number:
        </label>
        <input
          id="gi-regen-style"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (phase !== "idle" && phase !== "resolving") reset();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void findStyle();
            }
          }}
          placeholder="Style number"
          className="w-52 rounded border border-zinc-300 px-2 py-1.5 text-[13px]"
        />
        <button
          type="button"
          onClick={findStyle}
          disabled={!query.trim() || phase === "resolving" || phase === "running"}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
        >
          {phase === "resolving" ? "Looking up…" : "Find style"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {phase === "plan" && matches.length === 0 && (
        <p className="mt-3 text-[13px] text-zinc-500">
          No style matches <strong>{query.trim()}</strong>. Check the number — this searches every
          client, so a style under a different client would still show up here.
        </p>
      )}

      {(phase === "plan" || phase === "running") && matches.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {ambiguous ? (
              <>
                {matches.length} styles carry that number
                {matchedExactly ? "" : " (partial match)"} — the same style number appears once per
                order and once per colourway. All of them are corrected together.
              </>
            ) : (
              <>This will affect one style:</>
            )}
          </p>

          <ul className="mt-3 divide-y divide-amber-200 rounded-md border border-amber-200 bg-white">
            {matches.map((m) => (
              <li key={m.styleId} className="px-3 py-2">
                <label
                  className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 ${
                    m.hasCover ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(m.styleId)}
                    disabled={!m.hasCover || phase === "running"}
                    onChange={() => toggle(m.styleId)}
                    className="self-center"
                  />
                  <span className="font-mono text-[13px] font-semibold text-zinc-800">
                    {m.styleName}
                  </span>
                  {m.customerName && (
                    <span className="text-[12px] text-zinc-500">{m.customerName}</span>
                  )}
                  <span className="text-[12px] text-zinc-400">{m.poNumber ?? "no PO number"}</span>
                  <span className="text-[12px] text-zinc-400">
                    {m.supplierName ?? "no supplier linked"}
                  </span>
                  <span className="ml-auto text-[11px] text-zinc-400">{m.status}</span>
                </label>
                {!m.hasCover && (
                  <p className="mt-1 pl-6 text-[12px] text-amber-800">
                    Never generated a bundle, so there is no cover to rebuild. It will include the
                    current General information the first time it generates.
                  </p>
                )}
                {m.hasCover && !m.inThisSpec && (
                  <p className="mt-1 pl-6 text-[12px] text-amber-800">
                    Belongs to <strong>{m.prodSpecName ?? "another client"}</strong>, not{" "}
                    {scopeLabel} — its cover prints that client&rsquo;s General information, which
                    is what will be rebuilt.
                  </p>
                )}
              </li>
            ))}
          </ul>

          {selected.length === 0 ? (
            <p className="mt-3 text-[13px] leading-relaxed text-amber-900">
              Nothing to regenerate — none of these styles has a cover to rebuild yet.
            </p>
          ) : (
            <>
              <p className="mt-3 text-[13px] leading-relaxed text-amber-900">
                <strong>
                  {selected.length} {plural(selected.length, "style", "styles")}
                </strong>{" "}
                will have {plural(selected.length, "its", "their")} cover PDF rebuilt and
                re-uploaded, replacing the {plural(selected.length, "copy", "copies")} the{" "}
                {plural(selected.length, "supplier has", "suppliers have")} now.
                {foreign.length > 0 && (
                  <>
                    {" "}
                    {foreign.length} of {plural(foreign.length, "them belongs", "them belong")} to
                    another client and will print that client&rsquo;s General information, not{" "}
                    {scopeLabel}&rsquo;s.
                  </>
                )}{" "}
                Outputs are not re-rendered and approvals are untouched.
              </p>
              <label className="mt-3 flex items-start gap-2 text-[13px] text-amber-900">
                <input
                  type="checkbox"
                  checked={notifySupplier}
                  onChange={(e) => setNotifySupplier(e.target.checked)}
                  disabled={phase === "running"}
                  className="mt-0.5"
                />
                <span>
                  <strong>Also email the suppliers</strong> about it in tonight&rsquo;s digest. Off
                  by default — the corrected files reach their folders either way. Tick this only
                  if the change is one they must actually read.
                </span>
              </label>
            </>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={regenerate}
              disabled={phase === "running" || selected.length === 0}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              {phase === "running"
                ? `Regenerating ${selected.length} ${plural(selected.length, "style", "styles")}…`
                : `Regenerate and re-upload ${selected.length} ${plural(selected.length, "style", "styles")}`}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={phase === "running"}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
          {phase === "running" && selected.length > 1 && (
            <p className="mt-2 text-[12px] text-amber-800">
              Each cover is rebuilt and pushed in turn, so this takes a moment per style. The
              result below reports every one of them separately.
            </p>
          )}
        </div>
      )}

      {phase === "done" && run && (
        <div
          className={`mt-4 rounded-md border p-4 ${
            run.summary.allSucceeded
              ? "border-emerald-200 bg-emerald-50"
              : "border-amber-300 bg-amber-50"
          }`}
        >
          <p className="text-sm font-medium text-zinc-900">
            {run.summary.pushed} of {run.summary.total}{" "}
            {plural(run.summary.total, "style", "styles")} regenerated and delivered
            {run.summary.notPushed > 0 && `, ${run.summary.notPushed} rebuilt but not delivered`}
            {run.summary.pushFailed > 0 && `, ${run.summary.pushFailed} failed to upload`}
            {run.summary.noCover > 0 && `, ${run.summary.noCover} with no cover to rebuild`}
            {run.summary.failed > 0 && `, ${run.summary.failed} failed`}.
          </p>

          <ul className="mt-3 space-y-2">
            {run.results.map((r) => (
              <li
                key={r.styleId}
                className="rounded border border-zinc-200 bg-white px-3 py-2 text-[13px]"
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono font-semibold text-zinc-800">
                    {r.styleName ?? r.styleId}
                  </span>
                  {!r.inThisSpec && r.prodSpecName && (
                    <span className="text-[11px] text-zinc-400">{r.prodSpecName}</span>
                  )}
                  <span
                    className={`ml-auto text-[12px] font-medium ${
                      r.outcome === "pushed"
                        ? "text-emerald-700"
                        : r.outcome === "push-failed" || r.outcome === "error"
                          ? "text-red-700"
                          : "text-amber-800"
                    }`}
                  >
                    {r.outcome === "pushed"
                      ? "regenerated and pushed"
                      : r.outcome === "not-pushed"
                        ? "regenerated, not pushed"
                        : r.outcome === "push-failed"
                          ? "upload failed"
                          : r.outcome === "no-cover"
                            ? "nothing to rebuild"
                            : r.outcome === "not-found"
                              ? "no longer exists"
                              : "failed"}
                  </span>
                </div>

                {r.outcome === "pushed" && (
                  <p className="mt-1 text-zinc-600">
                    Cover rebuilt with the current General information and pushed to SharePoint
                    {r.folderUrl ? (
                      <>
                        {" — "}
                        <a
                          href={r.folderUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          open the folder
                        </a>
                      </>
                    ) : (
                      "."
                    )}
                  </p>
                )}
                {r.outcome === "not-pushed" && (
                  <p className="mt-1 text-amber-800">
                    Cover rebuilt, but nothing was uploaded: {requeueNote(r.requeue)}.
                  </p>
                )}
                {r.outcome === "push-failed" && (
                  <p className="mt-1 text-red-700">
                    The cover was rebuilt but did <strong>not</strong> reach SharePoint
                    {r.pushError ? `: ${r.pushError}` : "."} It stays queued and the recurring
                    supplier sweep will retry it.
                  </p>
                )}
                {(r.outcome === "no-cover" ||
                  r.outcome === "error" ||
                  r.outcome === "not-found") &&
                  r.message && <p className="mt-1 text-zinc-600">{r.message}</p>}
              </li>
            ))}
          </ul>

          {run.summary.pushed > 0 && (
            <p className="mt-3 text-[12px] text-zinc-500">
              {notifySupplier
                ? "The suppliers involved are included in tonight's digest."
                : "No emails were sent."}
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              reset();
              setQuery("");
            }}
            className="mt-4 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

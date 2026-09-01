"use client";

import { useCallback, useState } from "react";

// "Regenerate one style" — the narrow companion to the bulk panel below it.
//
// Saving General information changes what is generated FROM NOW ON; bundles
// that already exist keep the text they were built with. The bulk panel fixes
// that for a whole prod spec, which is right after a wording change everyone
// should see and much too broad when a single order needs correcting. This is
// the escape hatch for that case: type the style number, see exactly which
// style and order it resolved to, then rebuild that one cover and push it back
// into the supplier's folder.
//
// THREE THINGS THIS UI OWES THE PERSON USING IT:
//
//   1. Resolve BEFORE acting. A style number is not unique in this data — one
//      Pre-Order row per PO, two colourways per number — so several matches is
//      ordinary. The picker makes them choose rather than guessing for them.
//   2. Say what will happen, naming the actual style, order and supplier, while
//      the button is still unpressed. This overwrites a file in a supplier's
//      folder; that should never be a surprise.
//   3. Report what actually happened, per half. "Regenerated" and "pushed" are
//      separate facts and either can fail on its own — a rebuild that never
//      reached SharePoint must not read as done.

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

type RunResult = {
  styleName: string;
  refreshed: boolean;
  reason: string;
  message?: string;
  requeue: string | null;
  pushed: number;
  pushFailed: number;
  pushError?: string | null;
  notifySupplier?: boolean;
  sharePointStatus?: string | null;
  folderUrl?: string | null;
  sharePointError?: string | null;
};

type Phase = "idle" | "resolving" | "choose" | "ready" | "running" | "done";

// Plain-English reading of enqueueCoverForSupplier's outcome, so "regenerated
// but not pushed" always carries its reason instead of a bare enum.
function requeueNote(requeue: string | null): string | null {
  switch (requeue) {
    case "queued":
      return null;
    case "not-delivered":
      return "Not pushed: this style has no supplier to deliver to (or the client delivers their own goods).";
    case "no-outputs":
      return "Not pushed: the style has no generated layouts yet, and a cover is never sent to a supplier on its own.";
    case "below-cutoff":
      return "Not pushed: this order is below the supplier-send PO cutoff, so nothing is delivered for it.";
    case "error":
      return "Not pushed: arming the supplier queue failed. The cover itself was rebuilt.";
    default:
      return null;
  }
}

export function SingleStyleRegenPanel({
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
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [notifySupplier, setNotifySupplier] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
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
    setSelected(null);
    setResult(null);
    setError(null);
  }, []);

  const findStyle = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setPhase("resolving");
    setError(null);
    setResult(null);
    setSelected(null);
    try {
      const data = (await post({ mode: "resolve", styleNumber: q })) as {
        matches: Candidate[];
        ambiguous: boolean;
        matchedExactly: boolean;
      };
      setMatches(data.matches);
      setAmbiguous(data.ambiguous);
      setMatchedExactly(data.matchedExactly);
      // One unambiguous hit goes straight to the plan; anything else makes the
      // person choose. Note a single PARTIAL hit still lands here — the plan
      // card names it, so a half-remembered number can't act on the wrong row
      // without the real name being on screen first.
      if (data.matches.length === 1) {
        setSelected(data.matches[0]!);
        setPhase("ready");
      } else {
        setPhase("choose");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
      setPhase("idle");
    }
  }, [post, query]);

  const run = useCallback(async () => {
    if (!selected) return;
    setPhase("running");
    setError(null);
    try {
      const data = (await post({
        mode: "run",
        styleId: selected.styleId,
        notifySupplier,
      })) as RunResult;
      setResult(data);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regenerate failed");
      setPhase("ready");
    }
  }, [post, selected, notifySupplier]);

  return (
    <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-800">Regenerate one style</h2>
      <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
        Fixing a single order rather than the whole client? Enter its style number. This rebuilds
        that one style&rsquo;s cover PDF with the current General information for{" "}
        <strong>{scopeLabel}</strong> and pushes it back to the supplier&rsquo;s SharePoint folder,
        replacing the copy they have now. Nothing else is touched: no other style, no outputs, no
        approvals.
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

      {phase === "choose" && matches.length === 0 && (
        <p className="mt-3 text-[13px] text-zinc-500">
          No style matches <strong>{query.trim()}</strong>. Check the number — this searches every
          client, so a style under a different client would still show up here.
        </p>
      )}

      {phase === "choose" && matches.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] text-zinc-700">
            {ambiguous ? (
              <>
                <strong>{matches.length} styles</strong> match that number
                {matchedExactly ? "" : " (partially)"} — the same style number appears once per
                order and once per colourway. Pick the one you mean.
              </>
            ) : (
              <>Pick the style you mean.</>
            )}
          </p>
          <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {matches.map((m) => (
              <li key={m.styleId}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(m);
                    setPhase("ready");
                  }}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-zinc-50"
                >
                  <span className="font-mono text-[13px] font-semibold text-zinc-800">
                    {m.styleName}
                  </span>
                  {m.customerName && (
                    <span className="text-[12px] text-zinc-500">{m.customerName}</span>
                  )}
                  {m.poNumber && <span className="text-[12px] text-zinc-400">{m.poNumber}</span>}
                  <span className="ml-auto text-[11px] text-zinc-400">
                    {m.inThisSpec ? m.status : `other spec · ${m.prodSpecName ?? "unassigned"}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(phase === "ready" || phase === "running") && selected && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">This will affect one style:</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px] text-amber-900">
            <dt className="text-amber-700">Style</dt>
            <dd className="font-mono font-semibold">{selected.styleName}</dd>
            <dt className="text-amber-700">Client</dt>
            <dd>{selected.customerName ?? "—"}</dd>
            <dt className="text-amber-700">Order</dt>
            <dd>{selected.poNumber ?? "no PO number"}</dd>
            <dt className="text-amber-700">Supplier</dt>
            <dd>{selected.supplierName ?? "none linked"}</dd>
          </dl>

          {!selected.inThisSpec ? (
            <p className="mt-3 rounded border border-amber-300 bg-white px-3 py-2 text-[13px] text-amber-900">
              This style belongs to <strong>{selected.prodSpecName ?? "another client"}</strong>,
              not {scopeLabel}. Its cover prints that spec&rsquo;s General information, so
              regenerating it from here would publish the wrong text. Switch to that client and
              business area above.
            </p>
          ) : !selected.hasCover ? (
            <p className="mt-3 rounded border border-amber-300 bg-white px-3 py-2 text-[13px] text-amber-900">
              This style has never generated a bundle, so there is no cover to rebuild. It will
              include the current General information the first time it generates.
            </p>
          ) : (
            <>
              <p className="mt-3 text-[13px] leading-relaxed text-amber-900">
                Its cover PDF is rebuilt with the current General information and{" "}
                {selected.supplierName ? (
                  <>
                    re-uploaded to <strong>{selected.supplierName}</strong>&rsquo;s SharePoint
                    folder, replacing the cover they have now
                  </>
                ) : (
                  <>refreshed in-app — with no supplier linked there is nowhere to push it</>
                )}
                . Outputs are not re-rendered and approvals are untouched.
              </p>
              <label className="mt-3 flex items-start gap-2 text-[13px] text-amber-900">
                <input
                  type="checkbox"
                  checked={notifySupplier}
                  onChange={(e) => setNotifySupplier(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong>Also email the supplier</strong> about it in tonight&rsquo;s digest. Off
                  by default — the corrected file reaches their folder either way. Tick this only
                  if the change is one they must actually read.
                </span>
              </label>
            </>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={phase === "running" || !selected.inThisSpec || !selected.hasCover}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              {phase === "running" ? "Regenerating…" : "Regenerate and re-upload"}
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
        </div>
      )}

      {phase === "done" && result && (
        <div
          className={`mt-4 rounded-md border p-4 ${
            result.refreshed && result.pushFailed === 0
              ? "border-emerald-200 bg-emerald-50"
              : "border-amber-300 bg-amber-50"
          }`}
        >
          <p className="text-sm font-medium text-zinc-900">
            <span className="font-mono">{result.styleName}</span> —{" "}
            {result.refreshed ? "cover regenerated" : "nothing regenerated"}
          </p>

          {!result.refreshed && result.message && (
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-700">{result.message}</p>
          )}

          {result.refreshed && (
            <ul className="mt-2 space-y-1 text-[13px] text-zinc-700">
              <li>Cover PDF rebuilt with the current General information.</li>
              {result.pushed > 0 && (
                <li>
                  Pushed to SharePoint
                  {result.folderUrl ? (
                    <>
                      {" — "}
                      <a
                        href={result.folderUrl}
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
                  {result.notifySupplier
                    ? " The supplier is included in tonight's digest."
                    : " No email was sent."}
                </li>
              )}
              {result.pushFailed > 0 && (
                <li className="text-red-700">
                  The rebuilt cover did <strong>not</strong> reach SharePoint
                  {result.pushError ? `: ${result.pushError}` : "."} It stays queued and the
                  recurring supplier sweep will retry it.
                </li>
              )}
              {result.pushed === 0 && result.pushFailed === 0 && (
                <li className="text-amber-800">
                  {requeueNote(result.requeue) ??
                    "The cover was refreshed in-app but nothing was uploaded — supplier batch-send may be switched off, in which case it stays queued until it is on."}
                </li>
              )}
            </ul>
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

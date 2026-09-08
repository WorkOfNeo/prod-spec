"use client";

import { useCallback, useRef, useState } from "react";

// "See what changes, then change only those."
//
// The regen sweep next door rebuilds a target set you choose up front. This
// panel inverts that: it works out which covers would actually read differently
// FIRST, shows a handful side by side so a person can check the wording is
// right, and only then offers to rebuild — that exact list, nothing else.
//
// Two decisions are wired in rather than offered, because getting them wrong is
// expensive and getting them right is never situational:
//
//   * Suppliers are NOT emailed — and that is no longer a flag this panel sets,
//     it is what the regenerate route DOES. A bulk manifest refresh across
//     hundreds of orders is not news any supplier acts on, and mailing them
//     about it is how 714 emails went out on 2026-08-13. A genuine new document
//     still emails, through the ordinary approval path.
//   * Only changed covers are rebuilt, and each rebuild stamps its fingerprint.
//     So a second run does nothing, a stopped run resumes for free, and no
//     supplier's file is overwritten to change nothing.

type Phase = "idle" | "sampling" | "sample" | "scanning" | "scanned" | "running" | "done" | "error";

type DocRow = {
  displayName: string;
  widthMm: number | null;
  heightMm: number | null;
  approved?: boolean;
  kind?: "app" | "manual" | "info";
  suppliedAs?: string[];
  // Per-concept wording resolved by the manifest builder. Read here rather than
  // re-derived, so this preview says what the PDF will say.
  copy?: { note?: string; pending?: string; delivered?: string };
};

type Diff = {
  styleId: string;
  styleName: string;
  customerName: string | null;
  poNumber: string | null;
  changed: boolean;
  addedRows: number;
  before: DocRow[];
  after: DocRow[];
};

// Two full manifest builds per style, so the scan chunk is small.
const SCAN_CHUNK = 25;
// Styles shown side by side. Enough to spot a bad rule, few enough to read.
const SAMPLE_SIZE = 6;
// Puppeteer renders one cover at a time; keep the regen chunk as the sweep has it.
const REGEN_CHUNK = 5;

function statusLabel(d: DocRow): string {
  if (d.kind === "info") return "See packing instructions";
  if (d.approved === true) return d.copy?.delivered?.trim() || "Approved";
  if (d.approved === false) return d.copy?.pending?.trim() || "Waiting for Customer Information";
  return "—";
}

function DocList({ docs, emptyNote }: { docs: DocRow[]; emptyNote: string }) {
  if (docs.length === 0) {
    return <p className="px-3 py-2 text-[12px] italic text-zinc-400">{emptyNote}</p>;
  }
  return (
    <ol className="divide-y divide-zinc-100">
      {docs.map((d, i) => (
        // GREEN = this line is answered by a layout we already generate, so the
        // trim was matched to a real document. That match is the thing most
        // worth eyeballing — a wrong one promises the supplier artwork that
        // will never arrive — so it is the whole row that turns, not a badge
        // you have to hunt for.
        <li
          key={`${d.displayName}-${i}`}
          className={`px-3 py-2 ${d.kind === "app" ? "bg-emerald-50" : ""}`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] font-medium text-zinc-800">{d.displayName}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
              {d.widthMm !== null && d.heightMm !== null ? `${d.widthMm} × ${d.heightMm} mm` : "—"}
            </span>
          </div>
          {d.suppliedAs?.length ? (
            <div className="mt-0.5 text-[11px] text-emerald-800">
              Matched to {d.suppliedAs.join(" + ")}
            </div>
          ) : d.kind === "app" ? (
            <div className="mt-0.5 text-[11px] text-emerald-800">We generate this</div>
          ) : null}
          <div
            className={`mt-0.5 text-[11px] ${
              d.approved === false
                ? "text-amber-700"
                : d.approved === true
                  ? "text-emerald-700"
                  : "text-zinc-400"
            }`}
          >
            {statusLabel(d)}
          </div>
          {d.copy?.note?.trim() ? (
            <div className="mt-0.5 text-[11px] italic text-zinc-500">{d.copy.note.trim()}</div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function CoverChangesPanel({ prodSpecId }: { prodSpecId?: string } = {}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [allIds, setAllIds] = useState<string[]>([]);
  const [samples, setSamples] = useState<Diff[]>([]);
  const [scanned, setScanned] = useState(0);
  const [changedIds, setChangedIds] = useState<string[]>([]);
  const [regen, setRegen] = useState({ processed: 0, refreshed: 0, pushed: 0, errors: 0 });
  // Whether the master switch is on. Null until the first request answers.
  // While it is off, everything here still WORKS — that is the point, it is how
  // you decide — but rebuilding would write the old manifest, so it is barred.
  const [trimsEnabled, setTrimsEnabled] = useState<boolean | null>(null);
  // "Try one style number" — the direct check. Kept independent of the
  // sample/scan flow so it works at any moment, including before anything has
  // been scanned and while the master switch is off.
  const [styleQuery, setStyleQuery] = useState("");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const stopRef = useRef(false);

  const post = useCallback(async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
    }
    return res.json();
  }, []);

  const prepare = useCallback(async (): Promise<string[]> => {
    const data = (await post("/api/admin/settings/cover-page/preview-changes", {
      mode: "prepare",
      ...(prodSpecId ? { prodSpecId } : {}),
    })) as { styleIds: string[]; trimsEnabled: boolean };
    setAllIds(data.styleIds);
    setTrimsEnabled(data.trimsEnabled);
    return data.styleIds;
  }, [post, prodSpecId]);

  // Look at a handful with their full manifests. Cheap, and it is what tells
  // you whether the rules are right before you touch anything.
  const showSample = useCallback(async () => {
    setPhase("sampling");
    setError(null);
    try {
      const ids = await prepare();
      if (ids.length === 0) {
        setSamples([]);
        setPhase("sample");
        return;
      }
      const data = (await post("/api/admin/settings/cover-page/preview-changes", {
        mode: "scan",
        styleIds: ids.slice(0, SAMPLE_SIZE),
      })) as { diffs: Diff[] };
      setSamples(data.diffs);
      setPhase("sample");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build the sample");
      setPhase("error");
    }
  }, [post, prepare]);

  // Walk the whole estate for counts only, collecting the ids that need work.
  const scanAll = useCallback(async () => {
    stopRef.current = false;
    setPhase("scanning");
    setError(null);
    setScanned(0);
    setChangedIds([]);
    try {
      const ids = allIds.length > 0 ? allIds : await prepare();
      const found: string[] = [];
      for (let i = 0; i < ids.length; i += SCAN_CHUNK) {
        if (stopRef.current) break;
        const chunk = ids.slice(i, i + SCAN_CHUNK);
        const data = (await post("/api/admin/settings/cover-page/preview-changes", {
          mode: "scan",
          styleIds: chunk,
          countsOnly: true,
        })) as { diffs: Diff[] };
        for (const d of data.diffs) if (d.changed) found.push(d.styleId);
        setScanned((n) => n + chunk.length);
        setChangedIds([...found]);
      }
      setPhase("scanned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
      setPhase("error");
    }
  }, [allIds, post, prepare]);

  // Rebuild exactly the scanned list. onlyPending is OFF on purpose: an
  // all-approved style still gains its Monday trims, and skipping it would
  // leave the finished orders — the ones a supplier is working from right now —
  // showing the old short list.
  const runRegen = useCallback(async () => {
    // The button is hidden while the switch is off, but a stale tab could still
    // hold one. Refuse here too rather than quietly writing old manifests over
    // every supplier's current file.
    if (trimsEnabled === false) return;
    stopRef.current = false;
    setPhase("running");
    setError(null);
    const acc = { processed: 0, refreshed: 0, pushed: 0, errors: 0 };
    setRegen({ ...acc });
    for (let i = 0; i < changedIds.length; i += REGEN_CHUNK) {
      if (stopRef.current) break;
      const chunk = changedIds.slice(i, i + REGEN_CHUNK);
      try {
        const data = (await post("/api/admin/settings/cover-page/regenerate", {
          mode: "process",
          styleIds: chunk,
          deliver: true,
          onlyChanged: true,
          onlyPending: false,
        })) as { refreshed: number; pushed: number; errors: number };
        acc.refreshed += data.refreshed;
        acc.pushed += data.pushed;
        acc.errors += data.errors;
      } catch {
        acc.errors += chunk.length;
      }
      acc.processed += chunk.length;
      setRegen({ ...acc });
    }
    setPhase("done");
  }, [changedIds, post, trimsEnabled]);

  // Fetch rather than a plain link: a miss returns JSON, and sending someone to
  // a blank tab holding {"error":"No style matches..."} is a worse answer than
  // the message printed under the box. On success the bytes become a blob URL
  // and open in a new tab.
  const openSamplePdf = useCallback(async () => {
    const q = styleQuery.trim();
    if (!q) return;
    setPdfLoading(true);
    setPdfError(null);
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
      setPdfError(e instanceof Error ? e.message : "Could not render a sample");
    } finally {
      setPdfLoading(false);
    }
  }, [styleQuery]);

  const busy = phase === "sampling" || phase === "scanning" || phase === "running";

  return (
    <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">Preview cover changes</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
            Shows what each cover says now against what it would say with the Monday
            <strong> Trims</strong> list folded in, so you can check the wording before anything is
            rebuilt. Regenerating from here updates the covers in the suppliers&rsquo; SharePoint
            folders but <strong>does not email anyone</strong>, and touches only the covers that
            actually read differently.
          </p>
        </div>
        {phase === "idle" && (
          <button
            type="button"
            onClick={showSample}
            className="shrink-0 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Show me a sample
          </button>
        )}
        {phase === "sampling" && (
          <span className="shrink-0 py-2 text-sm text-zinc-400">Building sample…</span>
        )}
      </div>

      <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="cover-sample-style" className="text-[13px] font-medium text-zinc-700">
            Check one style:
          </label>
          <input
            id="cover-sample-style"
            value={styleQuery}
            onChange={(e) => setStyleQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void openSamplePdf();
              }
            }}
            placeholder="Style number"
            className="w-52 rounded border border-zinc-300 px-2 py-1.5 text-[13px]"
          />
          <button
            type="button"
            onClick={openSamplePdf}
            disabled={!styleQuery.trim() || pdfLoading}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            {pdfLoading ? "Rendering…" : "Open the real cover PDF"}
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">
          Renders that style&rsquo;s actual cover, with the trims folded in, through the same
          builder that produces the real thing — so it is the page itself, not a preview of one.
          Nothing is saved, pushed or emailed, and it works while the switch below is still off.
        </p>
        {pdfError && <p className="mt-2 text-[12px] text-red-600">{pdfError}</p>}
      </div>

      {phase === "error" && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          <button type="button" onClick={() => setPhase("idle")} className="ml-3 underline">
            Try again
          </button>
        </div>
      )}

      {(phase === "sample" || phase === "scanning" || phase === "scanned") && samples.length === 0 && (
        <p className="mt-4 text-sm text-zinc-500">
          No styles have a generated cover yet — nothing to preview.
        </p>
      )}

      {trimsEnabled === false && samples.length > 0 && phase !== "running" && phase !== "done" && (
        <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] text-sky-900">
          <strong>Trims on cover pages is off.</strong> The &ldquo;after&rdquo; column below is what
          covers <em>would</em> say once it is switched on — nothing is printing it yet, and every
          cover in the folders still reads exactly as before. Rebuilding is disabled while it is
          off, because it would write the old manifest rather than the one shown here. Turn it on
          in the panel below when you are ready.
        </div>
      )}

      {samples.length > 0 && phase !== "running" && phase !== "done" && (
        <div className="mt-5 space-y-4">
          {samples.map((d) => (
            <div key={d.styleId} className="rounded-md border border-zinc-200">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
                <span className="text-[13px] font-semibold text-zinc-800">{d.styleName}</span>
                {d.customerName && <span className="text-[12px] text-zinc-500">{d.customerName}</span>}
                {d.poNumber && <span className="text-[12px] text-zinc-400">{d.poNumber}</span>}
                <span className="ml-auto text-[11px] text-zinc-500">
                  {d.addedRows > 0 ? `+${d.addedRows} row${d.addedRows === 1 ? "" : "s"}` : "no new rows"}
                  {d.changed ? "" : " · cover already current"}
                </span>
              </div>
              <div className="grid grid-cols-1 divide-y divide-zinc-200 md:grid-cols-2 md:divide-x md:divide-y-0">
                <div>
                  <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                    Before
                  </div>
                  <DocList docs={d.before} emptyNote="No packaging listed at all." />
                </div>
                <div>
                  <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                    After
                  </div>
                  <DocList docs={d.after} emptyNote="No packaging listed at all." />
                </div>
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            {phase === "sample" && (
              <>
                <button
                  type="button"
                  onClick={scanAll}
                  className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
                >
                  Scan all {allIds.length} covers
                </button>
                <span className="text-[12px] text-zinc-500">
                  Read-only — works out which ones need rebuilding.
                </span>
              </>
            )}
            {phase === "scanning" && (
              <>
                <span className="text-[13px] text-zinc-600">
                  Scanned {scanned}/{allIds.length} · <strong>{changedIds.length}</strong> need
                  rebuilding
                </span>
                <button
                  type="button"
                  onClick={() => {
                    stopRef.current = true;
                  }}
                  className="text-[12px] text-zinc-600 underline"
                >
                  Stop
                </button>
              </>
            )}
            {phase === "scanned" && (
              <>
                <span className="text-[13px] text-zinc-700">
                  <strong>{changedIds.length}</strong> of {scanned} covers would change.
                </span>
                {changedIds.length > 0 &&
                  (trimsEnabled === false ? (
                    <span className="text-[12px] text-zinc-500">
                      Switch trims on below to rebuild these.
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={runRegen}
                      className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
                    >
                      Regenerate these {changedIds.length} — no supplier email
                    </button>
                  ))}
              </>
            )}
          </div>
        </div>
      )}

      {(phase === "running" || phase === "done") && (
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>
              {phase === "running" ? "Regenerating…" : "Done"} · {regen.processed}/
              {changedIds.length}
            </span>
            {phase === "running" && (
              <button
                type="button"
                onClick={() => {
                  stopRef.current = true;
                }}
                className="text-zinc-600 underline"
              >
                Stop
              </button>
            )}
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className={`h-full rounded-full transition-all ${
                phase === "done" ? "bg-emerald-500" : "bg-zinc-800"
              }`}
              style={{
                width: `${
                  changedIds.length > 0
                    ? Math.round((regen.processed / changedIds.length) * 100)
                    : 100
                }%`,
              }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-zinc-600">
            <span>
              Rebuilt <strong className="text-zinc-900">{regen.refreshed}</strong>
            </span>
            <span>
              Pushed to SharePoint <strong className="text-zinc-900">{regen.pushed}</strong>
            </span>
            <span className="text-zinc-500">No supplier emails sent</span>
            {regen.errors > 0 && <span className="text-red-600">Errors {regen.errors}</span>}
          </div>
          {phase === "done" && (
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setSamples([]);
                setChangedIds([]);
                setScanned(0);
                setRegen({ processed: 0, refreshed: 0, pushed: 0, errors: 0 });
              }}
              className="mt-4 rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Close
            </button>
          )}
        </div>
      )}

      {busy && phase === "sampling" && (
        <p className="mt-4 text-[13px] text-zinc-400">
          Building both manifests for {SAMPLE_SIZE} styles…
        </p>
      )}
    </div>
  );
}

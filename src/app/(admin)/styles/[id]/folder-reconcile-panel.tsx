"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FolderReconcile,
  MissingRow,
  RenamedRow,
  UnexpectedRow,
} from "@/lib/sharepoint/reconcile-folder";

// =====================================================
// "Does the supplier's folder actually match what we should have sent?" — the
// per-style, on-demand, bidirectional reconcile.
//
// The Supplier folder panel above this one answers "where WOULD files go" (the
// Monday resolution chain) and "how many files are in there" (a raw count).
// Neither can answer the two questions users actually ask when they report "the
// docs weren't uploaded correctly": which expected file is NOT there, and which
// file IS there that nothing accounts for. The second one is where a hand-rename
// after approval shows up, and it is not computed anywhere else in the app.
//
// Fetched lazily on mount — same reason as SupplierFolderFileCount: this costs
// several sequential Graph round-trips (resolve the sharing link, list the
// supplier root's folders, find the PO folder, find APPROVED LAYOUTS, list it)
// and the style page is already heavy and force-dynamic. Blocking the server
// render on it would make every style page wait on SharePoint.
//
// THE FOLDER IS THE PURCHASE ORDER'S, NOT THE STYLE'S. Most live PO folders
// hold several styles, so the diff behind this panel is computed across every
// style sharing the folder and each row says whose it is. This panel leads with
// THIS style's rows and keeps the siblings' as a short, subdued footnote — the
// user is on a style page and wants their own work first, but "12 of these files
// are the other style on this PO" is the sentence that stops them reporting a
// bug that isn't one.
//
// Three repairs, all explicitly itemised, never a blanket "fix everything":
//   • Re-upload missing — re-arms the queue rows to PENDING; the upload sweep
//     pushes them. NOTE this leaves BOTH copies when the file was hand-renamed,
//     which is why it is not the default and why the rename guess is shown
//     right next to it.
//   • Adopt renamed file — renames a HUMAN's file back to the expected name, in
//     place (same bytes, same version history). One file, not two.
//   • Re-push under the new name — for a TEMPLATE rename: restamp, upload the
//     approved bytes under the current name, then delete the old copy. Distinct
//     from adopt because the old file's bytes can't be trusted on a shared PO
//     folder (two styles with one style number overwrite each other), so the
//     artwork is taken from our own JobAsset rather than from the folder.
//
// A re-arm only queues work; the sweep that moves the bytes is gated on the
// supplierBatchSendEnabled master switch. When that is off we say so up front —
// otherwise pressing the button looks like it did nothing. The re-push does NOT
// go through that sweep: it uploads directly, so it works with the switch off.
// =====================================================

// Only the style id is required. `className` lets the caller place this in a
// grid cell (pass "") or standalone (the default top margin), matching the
// convention SupplierFolderStatus already uses on this page.
export type FolderReconcilePanelProps = {
  styleId: string;
  className?: string;
};

type ApplyResponse = { ok?: boolean; error?: string };

// Module-level on purpose: it touches no component state, so the mount effect
// can call it and do its setState inside the promise CALLBACKS. A helper that
// sets state itself would trip react-hooks/set-state-in-effect when called
// straight from an effect body, however many awaits are in the way — the same
// reason SupplierFolderFileCount inlines its fetch chain.
async function fetchReconcile(styleId: string, signal?: AbortSignal): Promise<FolderReconcile> {
  const res = await fetch(`/api/admin/styles/${styleId}/folder-reconcile`, { signal });
  const body = (await res.json().catch(() => ({}))) as FolderReconcile & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function FolderReconcilePanel({ styleId, className = "mt-8" }: FolderReconcilePanelProps) {
  const [data, setData] = useState<FolderReconcile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchReconcile(styleId, ctrl.signal)
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((e: Error) => {
        // An aborted in-flight check (the user navigating away) is not a
        // failure — say nothing rather than flashing an error on the way out.
        if (e.name === "AbortError") return;
        setError(e.message || "Folder check failed");
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [styleId]);

  // Re-run the check from an event handler (the Re-check button, and after
  // every apply). Only ever called from handlers, so setting state up front is
  // fine here in a way it is not inside the effect above.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchReconcile(styleId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Folder check failed");
    } finally {
      setLoading(false);
    }
  }, [styleId]);

  // Every apply re-reads the folder afterwards: the diff a user acted on is a
  // point-in-time snapshot, and leaving a stale one on screen after a change is
  // how someone ends up clicking the same repair twice.
  async function apply(label: string, body: Record<string, unknown>) {
    setBusy(label);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/folder-reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as ApplyResponse;
      if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
      setNotice(label);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const heading = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-zinc-700">
        Supplier folder check
        {data?.folderPath ? <span className="font-normal text-zinc-400"> · {data.folderPath}</span> : null}
        {/* The folder is the PO's, and this panel only ever repairs THIS style.
            The whole-PO ledger — including any sibling style with nothing
            delivered — lives on its own page. */}
        {data?.poNumber ? (
          <>
            {" · "}
            <a href={`/delivery/${encodeURIComponent(data.poNumber)}`} className="font-normal underline text-zinc-500 hover:text-zinc-900">
              whole PO
            </a>
          </>
        ) : null}
      </h2>
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading || busy !== null}
        className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
          loading || busy !== null
            ? "cursor-not-allowed border-zinc-200 text-zinc-400"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        {loading ? "Checking…" : "Re-check"}
      </button>
    </div>
  );

  if (loading && !data) {
    return (
      <section className={className}>
        {heading}
        <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500">
          Reading the supplier&apos;s folder…
        </div>
      </section>
    );
  }

  // A failed fetch is NOT a diff. Say the check didn't run — never let an empty
  // result read as "everything is fine" or as "the files are gone".
  if (error && !data) {
    return (
      <section className={className}>
        {heading}
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-2.5 text-xs text-amber-800">
          ⚠ Couldn&apos;t check the folder — {error}. Nothing is reported as missing: a failed lookup
          is not evidence that a file is gone.
        </div>
      </section>
    );
  }

  if (!data) return null;

  const listable = data.state === "ok" || data.state === "subfolder-missing";
  const { unexpected, ok } = data.diff;

  // This style's rows lead; a sibling's are the PO footnote. `unexpected` is
  // deliberately NOT split — a file no style on the PO accounts for belongs to
  // the folder, not to anyone, and is everyone's business.
  const renamed = data.diff.renamed.filter((r) => r.isSelf);
  const missing = data.diff.missing.filter((m) => m.isSelf);
  const notQueued = data.diff.notQueued.filter((n) => n.isSelf);
  const siblingIssues = [
    ...data.diff.renamed.filter((r) => !r.isSelf).map((r) => ({ styleId: r.styleId, styleName: r.styleName })),
    ...data.diff.missing.filter((m) => !m.isSelf).map((m) => ({ styleId: m.styleId, styleName: m.styleName })),
  ];
  const siblingIssueStyles = [...new Map(siblingIssues.map((s) => [s.styleId, s])).values()];

  const clean =
    listable &&
    renamed.length === 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    notQueued.length === 0;
  const rearmable = missing.filter((m) => m.queueItemId != null);
  const siblingFileCount = data.poExpectedCount - data.expectedCount;

  return (
    <section className={className}>
      {heading}

      {/* An unresolvable folder gets its own clear message instead of an empty
          diff — the states differ in what a human has to do about them. */}
      {!listable ? (
        <div
          className={`mt-2 rounded-lg border px-4 py-2.5 text-xs ${
            data.state === "unavailable"
              ? "border-amber-200 bg-amber-50/60 text-amber-800"
              : data.state === "po-folder-ambiguous"
                ? "border-fuchsia-200 bg-fuchsia-50/60 text-fuchsia-800"
                : "border-zinc-200 bg-zinc-50 text-zinc-600"
          }`}
        >
          {data.state === "unavailable" ? "⚠ " : data.state === "po-folder-ambiguous" ? "⚠ " : ""}
          {data.message}
          {data.ambiguousMatches.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {data.ambiguousMatches.map((m, i) => (
                <li key={i} className="truncate">
                  •{" "}
                  {m.webUrl ? (
                    <a href={m.webUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      {m.name} ↗
                    </a>
                  ) : (
                    m.name
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div
          className={`mt-2 overflow-hidden rounded-lg border ${
            clean ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/50"
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-100 bg-white/60 px-4 py-2 text-xs text-zinc-600">
            <span>
              Expected <span className="font-semibold text-zinc-800">{data.expectedCount}</span> from this
              style · present <span className="font-semibold text-zinc-800">{data.presentCount}</span> in the
              folder
            </span>
            <span className="text-zinc-400">·</span>
            <span>{ok.length} matched</span>
            {/* The folder is the PO's. Saying so up front is what stops a
                sibling's files reading as junk someone has to investigate. */}
            {data.siblingStyles.length > 0 ? (
              <>
                <span className="text-zinc-400">·</span>
                <span className="text-zinc-500">
                  shared PO folder — {siblingFileCount} more expected from{" "}
                  {data.siblingStyles.length === 1
                    ? `“${data.siblingStyles[0].styleName}”`
                    : `${data.siblingStyles.length} other styles`}
                  {data.siblingsTruncated > 0
                    ? ` (+${data.siblingsTruncated} not checked — too many styles on this PO)`
                    : ""}
                </span>
              </>
            ) : null}
            {data.folderUrl ? (
              <a
                href={data.folderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto underline hover:text-zinc-950"
              >
                Open folder ↗
              </a>
            ) : null}
          </div>

          {data.state === "subfolder-missing" ? (
            <div className="border-b border-zinc-100 px-4 py-2 text-xs text-amber-800">⚠ {data.message}</div>
          ) : null}

          {clean ? (
            <div className="px-4 py-2.5 text-xs text-emerald-800">
              ✓ The folder matches the current output config exactly — every file this style expects is
              there under the name its layout asks for today, and nothing in the folder is unaccounted for
              {data.siblingStyles.length > 0 ? " by some style on this PO" : ""}.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {/* Renamed first: it is the one bucket that is NOT a problem with
                  the artwork, and reading it before "missing" is what stops
                  someone hunting for a file that never moved. */}
              {renamed.map((r) => (
                <RenamedLine key={`r-${r.jobAssetId}`} row={r} />
              ))}
              {missing.map((m) => (
                <MissingLine key={`m-${m.variantKey}`} row={m} />
              ))}
              {unexpected.map((u) => (
                <UnexpectedLine
                  key={`u-${u.itemId}`}
                  row={u}
                  disabled={busy !== null || loading}
                  busy={busy}
                  onAdopt={apply}
                />
              ))}
              {notQueued.map((n) => (
                <li key={`n-${n.variantKey}`} className="flex items-start gap-2 px-4 py-2 text-xs">
                  <span aria-hidden className="mt-px shrink-0 font-semibold text-sky-600">
                    ⓘ
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-zinc-500">never queued</span>{" "}
                    <span className="break-all text-zinc-800">{n.fileName}</span>
                    <span className="block text-[11px] text-zinc-500">
                      The current output config expects this, but it was never added to the supplier-send
                      queue — so the automatic re-check has never looked for it
                      {n.present ? " (it IS in the folder, so someone pushed it by hand)" : ""}. Use the
                      style&apos;s “Push to supplier” action to send it.
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* The siblings' own gaps are theirs to fix, on their own page — but
              staying silent about them would make this panel look like it had
              simply ignored half the folder. */}
          {siblingIssueStyles.length > 0 ? (
            <div className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-500">
              Other styles on this PO have outstanding files too:{" "}
              {siblingIssueStyles.map((s, i) => (
                <span key={s.styleId}>
                  {i > 0 ? ", " : ""}
                  <a href={`/styles/${s.styleId}`} className="underline hover:text-zinc-800">
                    {s.styleName}
                  </a>
                </span>
              ))}
              . Open each to repair it — this panel only ever writes for the style you are on.
            </div>
          ) : null}

          {!clean ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-white/60 px-4 py-2">
              {renamed.length > 0 ? (
                <button
                  type="button"
                  disabled={busy !== null || loading}
                  onClick={() =>
                    void apply(`Re-pushed ${renamed.length} renamed output(s)`, {
                      action: "repush-renamed",
                      jobAssetIds: renamed.map((r) => r.jobAssetId),
                    })
                  }
                  title="Restamp the name, upload the approved PDF under it, then delete the old copy"
                  className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                    busy !== null || loading
                      ? "cursor-not-allowed border-zinc-200 text-zinc-400"
                      : "border-sky-300 bg-white text-sky-700 hover:bg-sky-50"
                  }`}
                >
                  {busy?.startsWith("Re-pushed")
                    ? "Re-pushing…"
                    : `Re-push under the new name (${renamed.length})`}
                </button>
              ) : null}
              {rearmable.length > 0 ? (
                <button
                  type="button"
                  disabled={busy !== null || loading}
                  onClick={() =>
                    void apply(`Re-armed ${rearmable.length} output(s) for re-upload`, {
                      action: "rearm-missing",
                      queueItemIds: [...new Set(rearmable.map((m) => m.queueItemId))],
                    })
                  }
                  className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                    busy !== null || loading
                      ? "cursor-not-allowed border-zinc-200 text-zinc-400"
                      : "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
                  }`}
                >
                  {busy?.startsWith("Re-armed") ? "Re-arming…" : `Re-upload missing (${rearmable.length})`}
                </button>
              ) : null}
              <span className="text-[11px] text-zinc-500">
                {renamed.length > 0
                  ? "Re-pushing uploads the approved PDF straight away (it doesn’t wait for the sweep), then removes the file left under the old name."
                  : rearmable.length > 0
                    ? data.batchSendEnabled
                      ? "Re-uploading queues the file for the next supplier upload sweep."
                      : "⚠ Automatic supplier sending is OFF — a re-upload will be queued but will not move until it is switched on at /settings."
                    : "Nothing here can be re-armed: these outputs have no supplier-send queue row."}
              </span>
            </div>
          ) : null}
        </div>
      )}

      {notice ? <div className="mt-1.5 text-[11px] text-emerald-700">✓ {notice}</div> : null}
      {error && data ? <div className="mt-1.5 text-[11px] text-red-600">{error}</div> : null}

      {/* Per-file adopt buttons live on the unexpected rows themselves — an
          adopt targets ONE file and ONE target name, so a single panel-level
          button could never express it. */}
      {listable && unexpected.some((u) => u.likelyRenamedFrom?.isSelf) ? (
        <div className="mt-1.5 text-[11px] text-zinc-500">
          “Adopt renamed file” renames the file already in the folder back to the expected name (same
          file, same history) — unlike re-uploading, which would leave both copies side by side.
        </div>
      ) : null}
    </section>
  );
}

// The two row renderers live at module scope, not inside the panel: a component
// declared in a render body gets a new identity every render, which makes React
// unmount and remount the whole row rather than update it.

// The file IS in the folder — under the name it was given at generation, before
// its layout's template was edited. Deliberately styled as information (sky, ⟳)
// rather than an error: nothing is lost, the folder is just behind.
function RenamedLine({ row }: { row: RenamedRow }) {
  const blocked = row.staleClaimedBy.length > 0;
  return (
    <li className="flex items-start gap-2 px-4 py-2 text-xs">
      <span aria-hidden className="mt-px shrink-0 font-semibold text-sky-600">
        ⟳
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-zinc-500">name changed</span>{" "}
        <span className="break-all text-zinc-800">{row.fileName}</span>
        <span className="block text-[11px] text-zinc-500">
          {row.name} · in the folder as{" "}
          {row.staleWebUrl ? (
            <a
              href={row.staleWebUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline hover:text-zinc-800"
            >
              “{row.previousFileName}” ↗
            </a>
          ) : (
            <span className="break-all">“{row.previousFileName}”</span>
          )}
          {blocked ? (
            <span className="block text-amber-700">
              ⚠ {row.staleClaimedBy.map((s) => `“${s.styleName}”`).join(", ")} on this PO still uses that
              file — re-pushing will upload the new name but leave the old file until that style is repaired
              too.
            </span>
          ) : null}
        </span>
      </span>
    </li>
  );
}

function MissingLine({ row }: { row: MissingRow }) {
  return (
    <li className="flex items-start gap-2 px-4 py-2 text-xs">
      <span aria-hidden className="mt-px shrink-0 font-semibold text-red-600">
        ✗
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-zinc-500">missing</span>{" "}
        <span className="break-all text-zinc-800">{row.fileName}</span>
        <span className="block text-[11px] text-zinc-500">
          {row.name}
          {row.likelyRenamedTo
            ? ` · looks like it was renamed by hand to “${row.likelyRenamedTo.fileName}” (${confidenceLabel(
                row.likelyRenamedTo.confidence,
              )})`
            : row.queued
              ? ` · queued as ${row.queueStatus ?? "—"}`
              : " · never queued"}
        </span>
      </span>
    </li>
  );
}

function UnexpectedLine({
  row,
  disabled,
  busy,
  onAdopt,
}: {
  row: UnexpectedRow;
  disabled: boolean;
  busy: string | null;
  onAdopt: (label: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const guess = row.likelyRenamedFrom;
  // The adopt button only exists when we have a rename candidate: without one
  // there is no expected name to rename the file TO, and inventing a target
  // would be exactly the guess this whole surface exists to avoid. It is also
  // hidden when the candidate belongs to a SIBLING style on the same PO — the
  // lib refuses that write, so offering the button would only produce a 409.
  const adoptable = guess?.isSelf === true;
  const label = `Adopted “${row.fileName}”`;
  return (
    <li className="flex items-start gap-2 px-4 py-2 text-xs">
      <span aria-hidden className="mt-px shrink-0 font-semibold text-amber-600">
        ⚠
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-zinc-500">unexpected</span>{" "}
        {row.webUrl ? (
          <a
            href={row.webUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-zinc-800 underline hover:text-zinc-950"
          >
            {row.fileName} ↗
          </a>
        ) : (
          <span className="break-all text-zinc-800">{row.fileName}</span>
        )}
        <span className="block text-[11px] text-zinc-500">
          {guess
            ? `← likely renamed by hand from “${guess.fileName}” (${guess.name}${
                guess.isSelf ? "" : ` · on “${guess.styleName}”, another style on this PO`
              } · ${confidenceLabel(guess.confidence)})`
            : "No style on this PO accounts for this file — not this one, and not any of its siblings sharing the folder."}
          {row.lastModifiedAt ? ` · changed ${row.lastModifiedAt.slice(0, 10)}` : ""}
        </span>
      </span>
      {adoptable && guess ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void onAdopt(label, {
              action: "adopt-renamed",
              itemId: row.itemId,
              toFileName: guess.fileName,
            })
          }
          title={`Rename it back to “${guess.fileName}”`}
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
            disabled
              ? "cursor-not-allowed border-zinc-200 text-zinc-400"
              : "border-amber-300 bg-white text-amber-700 hover:bg-amber-50"
          }`}
        >
          {busy === label ? "Adopting…" : "Adopt renamed file"}
        </button>
      ) : null}
    </li>
  );
}

// The similarity score is advisory — show it as a word, not a number, so it
// can't read as a threshold anyone should trust blindly.
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return "high confidence";
  if (confidence >= 0.7) return "medium confidence";
  return "low confidence";
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { FileDropZone } from "@/components/file-drop-zone";

// =====================================================
// "Manually supplied packaging" — one drop zone per MANUAL line of the style's
// cover manifest.
//
// A manual line is a trim the buyer's Monday "Trims" column names but this app
// generates no artwork for. The cover already tells the supplier to expect it;
// this is where the actual document goes. Uploading puts the file in the same
// APPROVED LAYOUTS folder the generated outputs land in, and flips that line on
// the cover from "Waiting for Customer Information" to "Approved".
//
// TWO WAYS TO ANSWER A LINE, and the second one is not a lesser version of the
// first. Drop the file here and the app uploads it; or press Approve, which
// says "the supplier's folder already has this — I put it there myself". The
// cover reads the same either way, because from the supplier's side it IS the
// same: the folder holds the document. The distinction the panel keeps is about
// what this app can offer you afterwards — there is no stored file to open and
// no SharePoint link to follow on a line that was approved by hand, and no file
// of ours to withdraw from the folder either.
//
// ANYONE WHO CAN REVIEW SEES THIS, reviewers included — the routes behind it
// gate on canReview, and the Review tab this sits on is already reviewer-
// reachable, so no role prop is threaded down here.
//
// EVERY ZONE IS LABELLED WITH THE COVER'S OWN WORDING. The labels come down
// from the server, which reads them off the same manifest the cover renders
// (buildRequiredPackagingForStyle → rows where kind === "manual"), so nothing
// here re-types or paraphrases a line. If the cover says "Wash Care Label with
// Oeko-tex Logo", so does the zone — that identity is the whole reason a person
// can tell which file belongs in which box.
// =====================================================

type Upload = {
  id: string;
  trimLabel: string;
  normalizedLabel: string;
  // Null when the line was approved by hand — there is no file on this side.
  originalName: string | null;
  fileName: string | null;
  byteSize: number | null;
  // `pushed` = this app put it in the folder. `manuallyApproved` = a person
  // says they did. `delivered` is the union, and is what the cover acts on.
  pushed: boolean;
  manuallyApproved: boolean;
  delivered: boolean;
  webUrl: string | null;
  deliveredAt: string | null;
  manualApprovedAt: string | null;
  uploadError: string | null;
};

type Line = { label: string; normalizedLabel: string; upload: Upload | null };

type Payload = {
  trimsEnabled: boolean;
  accepts: string[];
  maxBytes: number;
  lines: Line[];
  orphaned: Upload[];
};

export function ManualTrimsPanel({ styleId }: { styleId: string }) {
  const base = `/api/admin/styles/${styleId}/manual-trims`;
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Normalised label currently uploading — drives the per-zone busy state.
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  const fetchPayload = useCallback(async (): Promise<Payload> => {
    const res = await fetch(base, { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Couldn't load (HTTP ${res.status})`);
    }
    return (await res.json()) as Payload;
  }, [base]);

  // Post-mutation refetch — called from handlers, never from an effect.
  const refresh = useCallback(async () => {
    try {
      setData(await fetchPayload());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fetchPayload]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const p = await fetchPayload();
        if (active) {
          setData(p);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchPayload]);

  async function upload(line: Line, file: File) {
    setError(null);
    setBusyLabel(line.normalizedLabel);
    try {
      const form = new FormData();
      // The label goes back EXACTLY as the server sent it — the server checks
      // it against the manifest again and refuses anything that isn't a live
      // manual line.
      form.set("label", line.label);
      form.set("file", file);
      const res = await fetch(base, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string; delivered?: boolean };
      if (!res.ok) setError(body.error ?? `Upload failed (HTTP ${res.status})`);
      else if (body.delivered === false && body.error) setError(body.error);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyLabel(null);
    }
  }

  // "The supplier already has this one." No file, no Graph call — PATCH records
  // the statement and the cover stops waiting on the line. `approved: false`
  // withdraws it again.
  async function setApproved(line: Line, approved: boolean) {
    setError(null);
    setBusyLabel(line.normalizedLabel);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: line.label, approved }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Couldn't update it (HTTP ${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function remove(upload: Upload) {
    setError(null);
    setBusyLabel(upload.normalizedLabel);
    try {
      const res = await fetch(`${base}/${upload.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Couldn't remove it (HTTP ${res.status})`);
      }
      await refresh();
    } finally {
      setBusyLabel(null);
    }
  }

  if (loading) return <p className="text-xs text-zinc-400">Loading manually-supplied packaging…</p>;

  const accept = data ? data.accepts.map((e) => `.${e}`).join(",") : undefined;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500">
        Lines the cover page lists as <strong>manually supplied</strong> — named on the order&apos;s
        Trims column, but not produced by this app. Drop the finished document here and it goes into
        the same <span className="font-mono">APPROVED LAYOUTS</span> folder the generated outputs do,
        and the cover stops saying &ldquo;Waiting for Customer Information&rdquo; for that line.
      </p>
      <p className="text-xs text-zinc-500">
        Already put it in the supplier&apos;s folder yourself? Press <strong>Approve</strong> on that
        line instead — the cover treats it exactly as it treats an upload made here. Nothing is sent
        to SharePoint and nothing is deleted from it; the app is simply told the folder already has
        the document.
      </p>
      <p className="text-[11px] text-zinc-400">
        An already-generated cover PDF is rewritten by the &ldquo;Regenerate cover pages&rdquo; sweep
        (Settings ▸ Cover page), which now sees this style&apos;s manifest as changed. A cover
        generated after the upload carries it straight away.
      </p>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {data && !data.trimsEnabled && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Trims on the cover page are switched off, so no cover currently lists a manually-supplied
          line. Turn it on under Settings ▸ Cover page to use this.
        </p>
      )}

      {data && data.trimsEnabled && data.lines.length === 0 && (
        <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-center text-xs text-zinc-500">
          Nothing on this style&apos;s cover is manually supplied — every packaging line is produced
          here.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {data?.lines.map((line) => (
          <ZoneCard
            key={line.normalizedLabel}
            line={line}
            accept={accept}
            maxBytes={data.maxBytes}
            busy={busyLabel === line.normalizedLabel}
            styleId={styleId}
            onFile={(f) => void upload(line, f)}
            onRemove={(u) => void remove(u)}
            onApprove={(v) => void setApproved(line, v)}
          />
        ))}
      </div>

      {data && data.orphaned.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-900">
            No longer on the cover — still standing against the supplier&apos;s folder
          </p>
          <p className="mb-2 text-[11px] text-amber-800">
            The Trims column changed since these were supplied. Remove them unless the supplier
            should still have them. Removing an uploaded file takes it out of the folder; removing a
            line approved by hand only drops the record here — the document you put there yourself
            stays where it is.
          </p>
          <ul className="flex flex-col gap-1">
            {data.orphaned.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 text-xs text-amber-900">
                <span className="truncate">
                  {u.trimLabel} ·{" "}
                  {u.fileName ? (
                    <span className="font-mono">{u.fileName}</span>
                  ) : (
                    <span className="italic">approved by hand</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(u)}
                  className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// One manifest line. It can be in any of five states, and the card has to read
// honestly in all of them:
//
//   nothing yet                → drop zone, plus "Approve" for the document
//                                that is already in the folder
//   file stored + pushed       → the file, its SharePoint link, replace/remove
//   file stored, push failed   → the file, the reason, and "Approve" — the
//                                operator's usual way out is to carry it across
//                                by hand, which is precisely what Approve says
//   approved by hand, no file  → the statement, with Undo; the drop zone stays,
//                                because supplying the real file is still an
//                                improvement on someone's word
//   approved by hand + file    → both, with the statement explaining why a line
//                                this app never pushed nonetheless counts
function ZoneCard({
  line,
  accept,
  maxBytes,
  busy,
  styleId,
  onFile,
  onRemove,
  onApprove,
}: {
  line: Line;
  accept?: string;
  maxBytes: number;
  busy: boolean;
  styleId: string;
  onFile: (file: File) => void;
  onRemove: (upload: Upload) => void;
  onApprove: (approved: boolean) => void;
}) {
  const upload = line.upload;
  const hasFile = upload?.fileName != null;
  const approvedByHand = upload?.manuallyApproved === true;
  // Nothing to approve once this app has the file in the folder itself.
  const canApprove = !upload?.pushed && !approvedByHand;

  return (
    <div className="flex flex-col rounded-lg border border-zinc-200 bg-white p-3">
      {/* The cover's own wording, verbatim. Do not shorten or re-case it — a
          person is matching this against the printed page. */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-800">{line.label}</h3>
        <StatePill upload={upload} />
      </div>

      <div className="flex flex-col gap-2">
        {upload && hasFile && (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs">
            <a
              href={`/api/admin/styles/${styleId}/manual-trims/${upload.id}`}
              target="_blank"
              rel="noreferrer"
              className="block truncate font-medium text-zinc-800 underline-offset-2 hover:underline"
              title={upload.originalName ?? undefined}
            >
              {upload.originalName}
            </a>
            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500" title={upload.fileName ?? undefined}>
              {upload.fileName}
            </p>
            {upload.byteSize != null && (
              <p className="mt-0.5 text-[10px] text-zinc-400">{formatBytes(upload.byteSize)}</p>
            )}
          </div>
        )}

        {/* The statement, stated. A line the cover calls approved on somebody's
            word should say whose word it was on the screen where it was given. */}
        {approvedByHand && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[11px] text-emerald-900">
            <p className="font-medium">Approved by hand — uploaded to SharePoint outside this app.</p>
            <p className="mt-0.5 text-emerald-800">
              The cover lists this line as approved
              {upload?.manualApprovedAt ? ` since ${formatStamp(upload.manualApprovedAt)}` : ""}.
              {hasFile ? " The file above stayed here; it was never pushed from this app." : ""}
            </p>
          </div>
        )}

        {upload?.uploadError && (
          <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            {upload.uploadError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {upload?.webUrl && (
            <a
              href={upload.webUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Open in SharePoint
            </a>
          )}
          {canApprove && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove(true)}
              title="I have already put this document in the supplier's SharePoint folder myself — mark the cover line approved. Nothing is uploaded."
              className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              {busy ? "Working…" : "✓ Approve"}
            </button>
          )}
          {approvedByHand && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove(false)}
              title="Take the statement back — the cover goes back to waiting for this line. Nothing is removed from SharePoint."
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {busy ? "Working…" : "Undo approval"}
            </button>
          )}
          {upload && hasFile && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(upload)}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {busy ? "Working…" : "Remove"}
            </button>
          )}
        </div>

        {/* The drop zone never goes away while there is something better to
            have: the real file. Only a line this app has already pushed is
            finished, and there "replace" is what dropping means. */}
        <FileDropZone accept={accept} busy={busy} onFiles={(files) => files[0] && onFile(files[0])}>
          {({ dragOver, busy: b }) =>
            hasFile ? (
              <span className="text-[11px] text-zinc-500">
                {b ? "Uploading…" : dragOver ? "Drop to replace" : "Drop a new file to replace this"}
              </span>
            ) : (
              <>
                <span className="text-sm font-medium text-zinc-700">
                  {b
                    ? "Uploading…"
                    : dragOver
                      ? "Drop it"
                      : approvedByHand
                        ? "Optional: keep a copy here too"
                        : "Drop the document here"}
                </span>
                <span className="text-[11px] text-zinc-500">
                  or click to browse · PDF, artwork or an office document · max {formatBytes(maxBytes)}
                </span>
              </>
            )
          }
        </FileDropZone>
      </div>
    </div>
  );
}

function StatePill({ upload }: { upload: Upload | null }) {
  if (!upload) {
    return (
      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
        Not supplied
      </span>
    );
  }
  if (upload.manuallyApproved) {
    return (
      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
        Approved by hand
      </span>
    );
  }
  if (!upload.pushed) {
    return (
      <span className="shrink-0 rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-700">
        Saved, not in the folder
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
      In the supplier folder
    </span>
  );
}

// Date only — the hour somebody pressed a button is noise on a manifest line.
function formatStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

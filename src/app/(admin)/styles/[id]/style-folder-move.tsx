"use client";

import { useCallback, useEffect, useState } from "react";
import type { MoveAction, MoveToStyleFolderResult } from "@/lib/sharepoint/move-to-style-subfolder";

// =====================================================
// "Move into style folder" — the per-style tidy-up for the per-style subfolder
// layout inside APPROVED LAYOUTS.
//
// New POs (from the style-subfolder cutoff on) deliver straight into
// "APPROVED LAYOUTS/<style> - <colour>/". Anything delivered before sits flat in
// APPROVED LAYOUTS and stays there until someone moves it — which is this
// button. It also re-homes a style whose colour was corrected after its folder
// was made.
//
// ALWAYS TWO STEPS. Opening the dialog runs a dry run and lists exactly what
// would happen to which file (move / remove a duplicate / copy because the name
// is shared with another style / leave). Nothing touches SharePoint until
// "Move files" is pressed, and the server re-plans against a fresh listing then
// rather than trusting this preview.
// =====================================================

type Response = MoveToStyleFolderResult & { ok?: boolean; error?: string };

const ACTION_LABEL: Record<MoveAction, string> = {
  move: "move",
  "remove-duplicate": "remove duplicate",
  copy: "copy",
  left: "leave",
};

const ACTION_TONE: Record<MoveAction, string> = {
  move: "border-sky-200 bg-sky-50 text-sky-700",
  "remove-duplicate": "border-amber-300 bg-amber-100/70 text-amber-800",
  copy: "border-violet-200 bg-violet-50 text-violet-700",
  left: "border-zinc-200 bg-white text-zinc-600",
};

async function postMove(styleId: string, dryRun: boolean): Promise<Response> {
  const res = await fetch(`/api/admin/styles/${styleId}/folder-reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "move-to-style-folder", dryRun }),
  });
  const json = (await res.json().catch(() => ({}))) as Response;
  if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
  return json;
}

export function StyleFolderMoveButton({
  styleId,
  disabled,
  onDone,
}: {
  styleId: string;
  disabled?: boolean;
  // Called after a successful apply so the folder check behind re-reads.
  onDone: (notice: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Move this style's delivered files into its own “<style> - <colour>” folder inside APPROVED LAYOUTS"
        className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
          disabled
            ? "cursor-not-allowed border-zinc-200 text-zinc-400"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        Move to style folder
      </button>
      {open ? (
        <StyleFolderMoveDialog
          styleId={styleId}
          onClose={() => setOpen(false)}
          onDone={async (notice) => {
            setOpen(false);
            await onDone(notice);
          }}
        />
      ) : null}
    </>
  );
}

function StyleFolderMoveDialog({
  styleId,
  onClose,
  onDone,
}: {
  styleId: string;
  onClose: () => void;
  onDone: (notice: string) => Promise<void>;
}) {
  const [plan, setPlan] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Response | null>(null);

  // The preview. setState happens only in the promise callbacks — see the
  // note on fetchReconcile in folder-reconcile-panel.tsx.
  useEffect(() => {
    let live = true;
    postMove(styleId, true)
      .then((p) => {
        if (live) setPlan(p);
      })
      .catch((e: Error) => {
        if (live) setError(e.message || "Couldn't plan the move");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [styleId]);

  // Escape to close + lock body scroll, as the folder-check dialog does.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !applying) onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, applying]);

  const apply = useCallback(async () => {
    setApplying(true);
    setError(null);
    try {
      const r = await postMove(styleId, false);
      setResult(r);
      const c = r.counts;
      const notice =
        `Moved ${c.moved} file(s) into “${r.subfolderName}”` +
        (c.duplicatesRemoved > 0 ? `, removed ${c.duplicatesRemoved} duplicate(s)` : "") +
        (c.copied > 0 ? `, copied ${c.copied}` : "") +
        (c.left > 0 ? `, left ${c.left} shared file(s)` : "") +
        (c.failed > 0 ? ` — ${c.failed} failed, see the style's history` : "");
      if (c.failed === 0) await onDone(notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed");
    } finally {
      setApplying(false);
    }
  }, [styleId, onDone]);

  const shown = result ?? plan;
  const actionable = plan ? plan.items.filter((i) => i.action !== "left").length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-900/30 p-4 py-10"
      onClick={() => (applying ? null : onClose())}
      role="dialog"
      aria-modal="true"
      aria-label="Move to style folder"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-zinc-900">Move to style folder</h2>
            {shown ? (
              <p className="mt-0.5 break-all text-xs text-zinc-500">
                {shown.folderUrl ? (
                  <a href={shown.folderUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    {shown.folderPath} ↗
                  </a>
                ) : (
                  <>{shown.folderPath} (created on move)</>
                )}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 text-xs text-zinc-700">
          {loading ? (
            <p className="text-zinc-500">Working out which files are this style&apos;s…</p>
          ) : error && !shown ? (
            <p className="text-amber-800">⚠ {error}</p>
          ) : shown ? (
            <>
              <p className="text-zinc-600">
                {result
                  ? "Done. Each file's outcome is below."
                  : "Nothing has changed yet. This is what “Move files” will do:"}
              </p>
              {shown.previousSubfolderName ? (
                <p className="mt-1.5 text-zinc-600">
                  The style currently delivers into “{shown.previousSubfolderName}”. Its files move to the new name
                  {result
                    ? shown.previousFolderRemoved
                      ? " and the emptied old folder was removed."
                      : "; the old folder was kept because something is still in it."
                    : " and the old folder is removed once it is empty."}
                </p>
              ) : null}
              {shown.items.length === 0 ? (
                <p className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-600">
                  No files of this style are outside its folder — nothing to move.
                  {result ? "" : " Moving still creates the folder, so this style's next uploads land there."}
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200">
                  {shown.items.map((i) => {
                    return (
                      <li key={i.itemId} className="flex items-start gap-2 px-3 py-1.5">
                        <span
                          className={`mt-px shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${ACTION_TONE[i.action]}`}
                        >
                          {ACTION_LABEL[i.action]}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="break-all text-zinc-800">{i.fileName}</span>
                          <span className="block text-[11px] text-zinc-500">
                            from {i.from}
                            {i.sharedWith.length > 0 ? ` · name also used by ${i.sharedWith.map((s) => `“${s}”`).join(", ")}` : ""}
                            {i.reason ? ` · ${i.reason}` : ""}
                            {i.action === "copy" && !result
                              ? " · this style's approved PDF is uploaded into its folder; the shared file stays"
                              : ""}
                          </span>
                          {result && i.action !== "left" ? (
                            i.done ? (
                              <span className="block text-[11px] text-emerald-700">✓ done</span>
                            ) : (
                              <span className="block text-[11px] text-red-600">✗ {i.error ?? "not done"}</span>
                            )
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {error ? <p className="mt-2 text-red-600">{error}</p> : null}
            </>
          ) : null}
        </div>

        {!result && plan ? (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">
            <span className="mr-auto text-[11px] text-zinc-500">
              Files no style can claim, and other styles&apos; files, are never touched.
            </span>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying}
              className={`rounded-md border px-3 py-1 text-xs font-medium ${
                applying
                  ? "cursor-not-allowed border-zinc-200 text-zinc-400"
                  : "border-sky-300 bg-sky-600 text-white hover:bg-sky-700"
              }`}
            >
              {applying ? "Moving…" : actionable > 0 ? `Move files (${actionable})` : "Create folder"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

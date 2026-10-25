"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import {
  rowActions,
  type LayoutHistoryData,
  type OpenDraftView,
  type RevisionView,
} from "@/lib/output-layouts/revision-history";

// =====================================================
// Output Builder — layout History (design §5.1). Read-only list of the
// layout's revisions (change-request drafts, publishes, restores, the
// builder's own Publish) with two ways back: "Restore this version" and
// "Restore what was live before". A restore is never a rewind — the server
// drafts a NEW revision and publishes it, so it shows up here as the newest
// row and the layout version bumps.
//
// Mounted by the editor only when CHANGE_REQUESTS_ENABLED is on (the server
// page passes no history otherwise). After a restore the page refreshes; the
// page keys the editor on the layout version, so the editor remounts on the
// restored definition instead of keeping (and later autosaving) its stale
// copy. For the same reason restores wait while the editor has unsaved
// changes: a pending autosave landing after the restore would undo it.
// =====================================================

type CompareState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "done"; changes: string[] | null };

const STATUS_PILL: Record<string, string> = {
  DRAFT: "border-amber-200 bg-amber-50 text-amber-700",
  PUBLISHED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SUPERSEDED: "border-zinc-200 bg-zinc-50 text-zinc-500",
  DISCARDED: "border-zinc-200 bg-white text-zinc-400",
};

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// Client-only (the drawer renders after a click), so the viewer's locale is
// safe to use without a hydration mismatch.
function when(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// A failed response as lines for the inline error list: the message, then the
// publish gate's details on a 422 (a 400's zod `details` is an object — not
// for people, so it's left out).
async function errorLines(res: Response): Promise<string[]> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
  const details = Array.isArray(body.details) ? body.details.filter((d): d is string => typeof d === "string") : [];
  return [body.error ?? `HTTP ${res.status}`, ...details];
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const next = { ...rec };
  delete next[key];
  return next;
}

export function LayoutHistory({ history, editorDirty }: { history: LayoutHistoryData; editorDirty: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [compare, setCompare] = useState<Record<string, CompareState>>({});
  // Shown between a successful restore and the refresh that remounts the
  // editor (and this panel) on the new version.
  const [restored, setRestored] = useState<string | null>(null);

  // Esc closes the drawer (same as the guide drawer).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  async function toggleCompare(rev: RevisionView) {
    const current = compare[rev.id];
    if (current?.state === "loading") return;
    if (current) {
      setCompare((c) => without(c, rev.id));
      return;
    }
    setCompare((c) => ({ ...c, [rev.id]: { state: "loading" } }));
    try {
      const res = await fetch(`/api/admin/output-layouts/revisions/${rev.id}`);
      if (!res.ok) {
        const [message] = await errorLines(res);
        setCompare((c) => ({ ...c, [rev.id]: { state: "error", message } }));
        return;
      }
      const body = (await res.json()) as { changes: { summary: string }[] | null };
      setCompare((c) => ({
        ...c,
        [rev.id]: { state: "done", changes: body.changes ? body.changes.map((ch) => ch.summary) : null },
      }));
    } catch (err) {
      setCompare((c) => ({ ...c, [rev.id]: { state: "error", message: (err as Error).message } }));
    }
  }

  async function restore(rev: RevisionView, which: "definition" | "base") {
    const what =
      which === "definition"
        ? `revision #${rev.number}${rev.publishedVersion !== null ? ` (v${rev.publishedVersion})` : ""}`
        : `what was live before revision #${rev.number}`;
    const draft = history.openDraft;
    const supersedes = draft
      ? `\n\nThe open draft #${draft.number}${draft.changeRequestOutputId ? " from a change request" : ""} will be superseded.`
      : "";
    if (
      !window.confirm(
        `Put ${what} back live?\n\nThis publishes it as a new version of the layout — it prints from the next render.${supersedes}`,
      )
    ) {
      return;
    }
    setBusy(rev.id);
    setErrors((e) => without(e, rev.id));
    try {
      const res = await fetch(`/api/admin/output-layouts/revisions/${rev.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ which }),
      });
      if (!res.ok) {
        const lines = await errorLines(res);
        setErrors((e) => ({ ...e, [rev.id]: lines }));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { publishedVersion?: number };
      setRestored(
        `Restored — live now as ${body.publishedVersion !== undefined ? `v${body.publishedVersion}` : "a new version"}. Reloading the editor…`,
      );
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [rev.id]: [(err as Error).message] }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        title="Layout history — published versions and drafts, with restore"
      >
        <History className="h-3.5 w-3.5" aria-hidden />
        History
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          role="dialog"
          aria-modal="true"
          aria-label="Layout history"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-full w-full max-w-[34rem] flex-col bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3">
              <div className="text-sm font-semibold tracking-tight text-zinc-900">Layout history</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close history"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              >
                ✕
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {editorDirty ? (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  The editor has unsaved changes. Let them save before restoring — a save landing after a restore
                  would overwrite it.
                </p>
              ) : null}

              {restored ? (
                <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  {restored}
                </p>
              ) : null}

              {history.revisions.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No history yet. Publishing from the builder, a change request&apos;s draft and every restore are
                  recorded here.
                </p>
              ) : (
                <ul className="space-y-3">
                  {history.revisions.map((rev) => {
                    const actions = rowActions(rev);
                    const cmp = compare[rev.id];
                    const rowErrors = errors[rev.id];
                    const disabled = busy !== null || restored !== null || editorDirty;
                    return (
                      <li key={rev.id} className="rounded-lg border border-zinc-200 px-3.5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-zinc-800">#{rev.number}</span>
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              STATUS_PILL[rev.status] ?? STATUS_PILL.SUPERSEDED
                            }`}
                          >
                            {statusLabel(rev.status)}
                          </span>
                          {rev.publishedVersion !== null ? (
                            <span className="text-xs font-medium text-zinc-600">v{rev.publishedVersion}</span>
                          ) : null}
                          <span className="ml-auto text-xs text-zinc-400">{when(rev.createdAt)}</span>
                        </div>
                        <div data-private className="mt-1 text-xs text-zinc-500">
                          {rev.author}
                          {rev.publishedAt ? (
                            <>
                              {" · published "}
                              {when(rev.publishedAt)}
                              {rev.publishedBy ? ` by ${rev.publishedBy}` : ""}
                            </>
                          ) : null}
                        </div>
                        {rev.note ? <p className="mt-1.5 text-sm text-zinc-700">{rev.note}</p> : null}

                        {actions.compare || actions.restoreDefinition || actions.restoreBase ? (
                          <div className="mt-2.5 flex flex-wrap items-center gap-2">
                            {actions.compare ? (
                              <button
                                type="button"
                                onClick={() => toggleCompare(rev)}
                                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                              >
                                {cmp && cmp.state !== "loading" ? "Hide changes" : "Compare"}
                              </button>
                            ) : null}
                            {actions.restoreDefinition ? (
                              <button
                                type="button"
                                onClick={() => restore(rev, "definition")}
                                disabled={disabled}
                                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                              >
                                {busy === rev.id ? "Restoring…" : "Restore this version"}
                              </button>
                            ) : null}
                            {actions.restoreBase ? (
                              <button
                                type="button"
                                onClick={() => restore(rev, "base")}
                                disabled={disabled}
                                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                              >
                                Restore what was live before
                              </button>
                            ) : null}
                          </div>
                        ) : null}

                        {cmp ? (
                          <div className="mt-2 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                            {cmp.state === "loading" ? (
                              "Comparing…"
                            ) : cmp.state === "error" ? (
                              <span className="text-red-600">{cmp.message}</span>
                            ) : cmp.changes === null ? (
                              "These definitions couldn't be compared."
                            ) : cmp.changes.length === 0 ? (
                              "No differences from what was live when this revision was made."
                            ) : (
                              <>
                                <p className="mb-1 text-zinc-500">Changes from what was live before #{rev.number}:</p>
                                <ul className="space-y-0.5">
                                  {cmp.changes.map((c, i) => (
                                    <li key={i}>· {c}</li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </div>
                        ) : null}

                        {rowErrors ? (
                          <ul className="mt-2 space-y-0.5 text-xs text-red-600">
                            {rowErrors.map((e, i) => (
                              <li key={i}>· {e}</li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Shown at the top of the editor while a draft of this layout is open. The
// builder autosaves straight onto the live layout, and a draft remembers the
// live layout it was made from — so any edit here makes that draft's publish
// refuse with a conflict until it's redrafted.
export function OpenDraftNotice({ draft }: { draft: OpenDraftView }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <span>
        {draft.changeRequestOutputId ? "A change request has an open draft" : "There is an open draft"} for this
        layout (draft #{draft.number}). Edits here will make that draft conflict.
      </span>
      {draft.requestId ? (
        <Link
          href={`/requests/${draft.requestId}`}
          className="font-medium text-amber-900 underline-offset-2 hover:underline"
        >
          Open the request →
        </Link>
      ) : null}
    </div>
  );
}

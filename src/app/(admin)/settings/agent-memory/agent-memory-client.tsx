"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, History, Pencil, RotateCcw, Trash2, X } from "lucide-react";

// Client half of /settings/agent-memory: scope chips, the notes grouped by
// what needs doing, per-note actions (PATCH /api/admin/agent-memory/[id] then
// router.refresh()) and the follow-along log. The server decides which moves
// are legal (memory.ts); the buttons shown per state just match it.

export type MemoryView = {
  id: string;
  scope: string;
  scopeLabel: string;
  text: string;
  state: string;
  sourceLabel: string;
  sourceRequestId: string | null;
  usedCount: number;
  lastUsedLabel: string | null;
  updatedLabel: string;
};

export type MemoryEventView = {
  key: string;
  kind: string;
  label: string;
  text: string;
  scopeLabel: string;
  source: string;
  whenLabel: string;
};

const SCOPE_CHIPS: Array<{ scope: string | null; label: string }> = [
  { scope: null, label: "All" },
  { scope: "GLOBAL", label: "Everywhere" },
  { scope: "CUSTOMER", label: "Customer" },
  { scope: "DOC_TYPE", label: "Doc type" },
  { scope: "MONDAY", label: "Monday data" },
];

const STATE_PILL: Record<string, { label: string; className: string }> = {
  PROPOSED: { label: "Suggested", className: "border-amber-200 bg-amber-50 text-amber-700" },
  KEPT: { label: "Kept", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  DISMISSED: { label: "Dismissed", className: "border-zinc-200 bg-zinc-100 text-zinc-500" },
  FORGOTTEN: { label: "Forgotten", className: "border-zinc-200 bg-zinc-100 text-zinc-500" },
};

const EVENT_DOT: Record<string, string> = {
  suggested: "bg-amber-400",
  kept: "bg-emerald-500",
  used: "bg-blue-500",
  dismissed: "bg-zinc-300",
  forgotten: "bg-zinc-300",
};

export function AgentMemoryClient({ memories, events }: { memories: MemoryView[]; events: MemoryEventView[] }) {
  const [scope, setScope] = useState<string | null>(null);
  const shown = scope ? memories.filter((m) => m.scope === scope) : memories;
  const count = (s: string | null) => (s ? memories.filter((m) => m.scope === s).length : memories.length);

  const proposed = shown.filter((m) => m.state === "PROPOSED");
  const kept = shown.filter((m) => m.state === "KEPT");
  const closed = shown.filter((m) => m.state === "DISMISSED" || m.state === "FORGOTTEN");

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by scope">
          {SCOPE_CHIPS.map((chip) => {
            const active = scope === chip.scope;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => setScope(chip.scope)}
                aria-pressed={active}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active
                    ? "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    : "border-line bg-surface text-ink hover:bg-subtle"
                }`}
              >
                {chip.label}
                <span className={`ml-1.5 font-mono tabular-nums ${active ? "text-faint" : "text-faint"}`}>
                  {count(chip.scope)}
                </span>
              </button>
            );
          })}
        </div>

        {memories.length === 0 ? (
          <div className="mt-6 rounded-xl border border-line bg-surface p-8 text-center">
            <div className="text-sm font-semibold text-ink">No notes yet.</div>
            <p className="mt-1 text-sm text-muted">
              When you correct a draft in a review, the agent may suggest a note. It shows up here
              for you to keep or dismiss.
            </p>
          </div>
        ) : (
          <div className="mt-5 grid gap-6">
            <Section
              title="Waiting for you"
              hint="Suggested by the agent. It won't read these until you keep them."
              notes={proposed}
              empty="Nothing waiting."
            />
            <Section
              title="Kept"
              hint="The agent reads these on every run that matches their scope."
              notes={kept}
              empty="No kept notes here."
            />
            {closed.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer text-sm font-semibold text-ink select-none">
                  Dismissed and forgotten{" "}
                  <span className="font-mono font-normal text-faint tabular-nums">{closed.length}</span>
                </summary>
                <p className="mt-1 text-xs text-muted">The agent doesn&apos;t read these. Restore one to use it again.</p>
                <ul className="mt-2 grid gap-2">
                  {closed.map((m) => (
                    <NoteRow key={m.id} note={m} />
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        )}
      </div>

      <aside className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <History className="h-4 w-4 text-faint" aria-hidden="true" />
          Follow along
        </h2>
        <p className="mt-1 text-xs text-muted">The latest thing that happened to each note, newest first.</p>
        {events.length === 0 ? (
          <p className="mt-3 text-xs text-faint">Nothing yet.</p>
        ) : (
          <ol className="mt-3 grid gap-3 border-l border-line pl-4">
            {events.map((e) => (
              <li key={e.key} className="relative">
                <span
                  className={`absolute top-1.5 -left-[1.3rem] h-2 w-2 rounded-full ${EVENT_DOT[e.kind] ?? "bg-zinc-300"}`}
                  aria-hidden="true"
                />
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-ink">{e.label}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">{e.whenLabel}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{e.text}</p>
                <p className="mt-0.5 text-[11px] text-faint">
                  {e.scopeLabel} · {e.source}
                </p>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

function Section({ title, hint, notes, empty }: { title: string; hint: string; notes: MemoryView[]; empty: string }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-ink">
        {title} <span className="font-mono font-normal text-faint tabular-nums">{notes.length}</span>
      </h2>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
      {notes.length === 0 ? (
        <p className="mt-2 text-xs text-faint">{empty}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {notes.map((m) => (
            <NoteRow key={m.id} note={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteRow({ note }: { note: MemoryView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function patch(body: { state?: string; text?: string }): Promise<boolean> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/agent-memory/${note.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveText() {
    if (await patch({ text: draft })) setEditing(false);
  }

  const pill = STATE_PILL[note.state] ?? { label: note.state, className: "border-zinc-200 bg-zinc-100 text-zinc-500" };
  const closed = note.state === "DISMISSED" || note.state === "FORGOTTEN";

  return (
    <li className={`rounded-xl border border-line bg-surface p-3 ${closed ? "opacity-75" : ""}`}>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={1000}
          autoFocus
          className="w-full rounded-md border border-line px-3 py-2 text-sm leading-relaxed focus:ring-2 focus:ring-accent focus:outline-none"
        />
      ) : (
        <p className={`text-sm whitespace-pre-line ${closed ? "text-muted" : "text-ink"}`}>{note.text}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="rounded border border-line bg-subtle px-1.5 py-0.5 text-muted">{note.scopeLabel}</span>
        <span className={`rounded-full border px-2 py-0.5 font-semibold ${pill.className}`}>{pill.label}</span>
        <span className="text-muted">
          {note.sourceRequestId ? (
            <Link href={`/requests/${note.sourceRequestId}`} className="hover:text-ink hover:underline">
              {note.sourceLabel}
            </Link>
          ) : (
            note.sourceLabel
          )}
        </span>
        <span className="text-faint" title={note.lastUsedLabel ? `Last read ${note.lastUsedLabel}` : undefined}>
          used in <span className="font-mono tabular-nums">{note.usedCount}</span> draft{note.usedCount === 1 ? "" : "s"}
        </span>

        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {editing ? (
            <>
              <ActionButton onClick={saveText} disabled={busy || draft.trim() === ""} primary>
                {busy ? "Saving…" : "Save"}
              </ActionButton>
              <ActionButton
                onClick={() => {
                  setEditing(false);
                  setDraft(note.text);
                  setErr(null);
                }}
                disabled={busy}
              >
                Cancel
              </ActionButton>
            </>
          ) : note.state === "PROPOSED" ? (
            <>
              <ActionButton onClick={() => patch({ state: "KEPT" })} disabled={busy} primary>
                <Check className="h-3.5 w-3.5" aria-hidden="true" /> Keep
              </ActionButton>
              <ActionButton onClick={() => patch({ state: "DISMISSED" })} disabled={busy}>
                <X className="h-3.5 w-3.5" aria-hidden="true" /> Dismiss
              </ActionButton>
            </>
          ) : note.state === "KEPT" ? (
            <>
              <ActionButton
                onClick={() => {
                  setDraft(note.text);
                  setEditing(true);
                }}
                disabled={busy}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
              </ActionButton>
              <ActionButton onClick={() => patch({ state: "FORGOTTEN" })} disabled={busy}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Forget
              </ActionButton>
            </>
          ) : closed ? (
            <ActionButton
              onClick={() => patch({ state: note.state === "FORGOTTEN" ? "KEPT" : "PROPOSED" })}
              disabled={busy}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Restore
            </ActionButton>
          ) : null}
        </span>
      </div>
      {err ? <p className="mt-1.5 text-xs text-bad">{err}</p> : null}
    </li>
  );
}

function ActionButton({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${
        primary
          ? "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          : "border border-line bg-surface text-ink hover:bg-subtle"
      }`}
    >
      {children}
    </button>
  );
}

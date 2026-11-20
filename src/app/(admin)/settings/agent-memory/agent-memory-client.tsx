"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, History, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";

// Client half of /settings/agent-memory: a note written by hand (POST
// /api/admin/agent-memory), scope chips, the notes grouped by what needs
// doing, per-note actions (PATCH /api/admin/agent-memory/[id] then
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

export type ScopeOption = { value: string; label: string };

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

export function AgentMemoryClient({
  memories,
  events,
  customers,
  docTypes,
}: {
  memories: MemoryView[];
  events: MemoryEventView[];
  customers: ScopeOption[];
  docTypes: ScopeOption[];
}) {
  const [scope, setScope] = useState<string | null>(null);
  const shown = scope ? memories.filter((m) => m.scope === scope) : memories;
  const count = (s: string | null) => (s ? memories.filter((m) => m.scope === s).length : memories.length);

  const proposed = shown.filter((m) => m.state === "PROPOSED");
  const kept = shown.filter((m) => m.state === "KEPT");
  const closed = shown.filter((m) => m.state === "DISMISSED" || m.state === "FORGOTTEN");

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <AddNote customers={customers} docTypes={docTypes} />

        <div className="mt-6 flex flex-wrap gap-1.5" role="group" aria-label="Filter by scope">
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
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {chip.label}
                <span className={`ml-1.5 font-mono tabular-nums ${active ? "text-zinc-300" : "text-zinc-400"}`}>
                  {count(chip.scope)}
                </span>
              </button>
            );
          })}
        </div>

        {memories.length === 0 ? (
          <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-8 text-center">
            <div className="text-sm font-semibold text-zinc-800">No notes yet.</div>
            <p className="mt-1 text-sm text-zinc-500">
              Write one above, or correct a draft in a review: the agent may suggest a note, and it
              shows up here for you to keep or dismiss.
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
                <summary className="cursor-pointer text-sm font-semibold text-zinc-700 select-none">
                  Dismissed and forgotten{" "}
                  <span className="font-mono font-normal text-zinc-400 tabular-nums">{closed.length}</span>
                </summary>
                <p className="mt-1 text-xs text-zinc-500">The agent doesn&apos;t read these. Restore one to use it again.</p>
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
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <History className="h-4 w-4 text-zinc-400" aria-hidden="true" />
          Follow along
        </h2>
        <p className="mt-1 text-xs text-zinc-500">The latest thing that happened to each note, newest first.</p>
        {events.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-400">Nothing yet.</p>
        ) : (
          <ol className="mt-3 grid gap-3 border-l border-zinc-200 pl-4">
            {events.map((e) => (
              <li key={e.key} className="relative">
                <span
                  className={`absolute top-1.5 -left-[1.3rem] h-2 w-2 rounded-full ${EVENT_DOT[e.kind] ?? "bg-zinc-300"}`}
                  aria-hidden="true"
                />
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-800">{e.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400 tabular-nums">{e.whenLabel}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-zinc-600">{e.text}</p>
                <p className="mt-0.5 text-[11px] text-zinc-400">
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

const NEW_NOTE_SCOPES: Array<{ scope: string; label: string; hint: string }> = [
  { scope: "GLOBAL", label: "Everywhere", hint: "Every run reads it." },
  { scope: "MONDAY", label: "Monday data", hint: "What a Monday column means and what it causes. Every run reads it." },
  { scope: "CUSTOMER", label: "Customer", hint: "Runs on this customer's requests." },
  { scope: "DOC_TYPE", label: "Doc type", hint: "Runs on outputs of this document type." },
];
const NOTE_MAX = 1000;

// A note written by hand: kept at once, so the next matching run reads it.
function AddNote({ customers, docTypes }: { customers: ScopeOption[]; docTypes: ScopeOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("MONDAY");
  const [scopeRef, setScopeRef] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refOptions = scope === "CUSTOMER" ? customers : scope === "DOC_TYPE" ? docTypes : null;
  const hint = NEW_NOTE_SCOPES.find((s) => s.scope === scope)?.hint;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add a note
      </button>
    );
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/agent-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, scopeRef: refOptions ? scopeRef : null, text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? `Saving failed (${res.status})`);
        return;
      }
      setText("");
      setOpen(false);
      router.refresh();
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">Add a note</h2>
      <p className="mt-0.5 text-xs text-zinc-500">
        Something the agent should know that it can&apos;t find in the data. Say what causes it and what to check
        or tell the requester. Kept at once.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-zinc-700" htmlFor="note-scope">
          Applies to
        </label>
        <select
          id="note-scope"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setScopeRef("");
          }}
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
        >
          {NEW_NOTE_SCOPES.map((s) => (
            <option key={s.scope} value={s.scope}>
              {s.label}
            </option>
          ))}
        </select>
        {refOptions && (
          <select
            aria-label={scope === "CUSTOMER" ? "Customer" : "Doc type"}
            value={scopeRef}
            onChange={(e) => setScopeRef(e.target.value)}
            disabled={busy}
            className="min-w-0 max-w-xs rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">{scope === "CUSTOMER" ? "Pick a customer…" : "Pick a doc type…"}</option>
            {refOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {hint && <span className="text-xs text-zinc-500">{hint}</span>}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={NOTE_MAX}
        disabled={busy}
        aria-label="Note"
        placeholder="e.g. A certificate mark or page (OEKO-TEX, FSC) prints because the style's Monday Certificates column lists it…"
        className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !text.trim() || (refOptions !== null && !scopeRef)}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          Save note
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setErr(null);
          }}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
        >
          Cancel
        </button>
        <span className="ml-auto font-mono text-[11px] text-zinc-400 tabular-nums">
          {text.length}/{NOTE_MAX}
        </span>
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </section>
  );
}

function Section({ title, hint, notes, empty }: { title: string; hint: string; notes: MemoryView[]; empty: string }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-900">
        {title} <span className="font-mono font-normal text-zinc-400 tabular-nums">{notes.length}</span>
      </h2>
      <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>
      {notes.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-400">{empty}</p>
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
    <li className={`rounded-lg border border-zinc-200 bg-white p-3 ${closed ? "opacity-75" : ""}`}>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={1000}
          autoFocus
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm leading-relaxed focus:ring-2 focus:ring-zinc-900 focus:outline-none"
        />
      ) : (
        <p className={`text-sm whitespace-pre-line ${closed ? "text-zinc-500" : "text-zinc-900"}`}>{note.text}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-zinc-600">{note.scopeLabel}</span>
        <span className={`rounded-full border px-2 py-0.5 font-semibold ${pill.className}`}>{pill.label}</span>
        <span className="text-zinc-500">
          {note.sourceRequestId ? (
            <Link href={`/requests/${note.sourceRequestId}`} className="hover:text-zinc-800 hover:underline">
              {note.sourceLabel}
            </Link>
          ) : (
            note.sourceLabel
          )}
        </span>
        <span className="text-zinc-400" title={note.lastUsedLabel ? `Last read ${note.lastUsedLabel}` : undefined}>
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
      {err ? <p className="mt-1.5 text-xs text-red-600">{err}</p> : null}
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
          ? "bg-zinc-900 text-white hover:bg-zinc-800"
          : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
      }`}
    >
      {children}
    </button>
  );
}

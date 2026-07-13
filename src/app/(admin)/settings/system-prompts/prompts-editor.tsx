"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type PromptView = {
  key: string;
  name: string;
  description: string;
  content: string;
  source: "custom" | "default";
  updatedByEmail: string | null;
  updatedAtLabel: string | null;
};

export function PromptsEditor({ prompts, canSave }: { prompts: PromptView[]; canSave: boolean }) {
  return (
    <div className="grid max-w-3xl gap-5">
      {prompts.map((p) => (
        <PromptCard key={p.key} prompt={p} canSave={canSave} />
      ))}
    </div>
  );
}

function PromptCard({ prompt, canSave }: { prompt: PromptView; canSave: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(prompt.content);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const dirty = value !== prompt.content;

  async function save() {
    setBusy("save");
    setErr(null);
    setOk(null);
    try {
      const res = await fetch(`/api/admin/system-prompts/${prompt.key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setOk("Saved — live on the next AI run.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!confirm(`Reset "${prompt.name}" to the built-in default? Your edits will be removed.`)) return;
    setBusy("reset");
    setErr(null);
    setOk(null);
    try {
      const res = await fetch(`/api/admin/system-prompts/${prompt.key}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      if (typeof body.content === "string") setValue(body.content);
      setOk("Reset to the built-in default.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-900">{prompt.name}</h2>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                prompt.source === "custom"
                  ? "border-violet-200 bg-violet-50 text-violet-700"
                  : "border-zinc-200 bg-zinc-100 text-zinc-500"
              }`}
            >
              {prompt.source === "custom" ? "customized" : "default"}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{prompt.description}</p>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-zinc-400">{prompt.key}</span>
      </div>

      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOk(null);
        }}
        rows={14}
        spellCheck={false}
        className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-relaxed focus:ring-2 focus:ring-zinc-900 focus:outline-none"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSave || !dirty || busy !== null}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          title={!canSave ? "Saving is disabled until db:deploy runs" : undefined}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        {prompt.source === "custom" ? (
          <button
            type="button"
            onClick={reset}
            disabled={busy !== null}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy === "reset" ? "Resetting…" : "Reset to default"}
          </button>
        ) : null}
        {dirty ? <span className="text-xs text-amber-600">unsaved changes</span> : null}
        {ok ? <span className="text-xs text-emerald-700">{ok}</span> : null}
        {err ? <span className="text-xs text-red-600">{err}</span> : null}
        <span className="ml-auto text-[11px] text-zinc-400">
          {prompt.source === "custom" && prompt.updatedAtLabel
            ? `Edited ${prompt.updatedAtLabel}${prompt.updatedByEmail ? ` by ${prompt.updatedByEmail}` : ""}`
            : "Built-in default"}
        </span>
      </div>
    </div>
  );
}

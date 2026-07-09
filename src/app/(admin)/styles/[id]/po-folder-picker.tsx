"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Pick THE PO folder for a style when the supplier's SharePoint has several
// matching the PO. Open to every role: whoever spots it can unblock delivery.
// Choosing persists Style.supplierPoFolderName, re-arms the queue and pushes
// into the chosen folder — the row stops being "ambiguous" on the next render.

export type FolderChoice = { name: string; webUrl: string | null };

export function PoFolderPicker({
  styleId,
  matches,
  compact = false,
}: {
  styleId: string;
  matches: FolderChoice[];
  // Denser styling for the /settings/approved table cell.
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(name: string) {
    setError(null);
    setChoosing(name);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/choose-po-folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderName: name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
      setChoosing(null);
    }
  }

  const busy = pending || choosing !== null;

  return (
    <div className={compact ? "space-y-1" : "mt-1.5 space-y-1.5"}>
      {matches.map((m, i) => (
        <div key={i} className="flex items-center gap-2">
          <span aria-hidden className="text-fuchsia-400">
            •
          </span>
          {m.webUrl ? (
            <a
              href={m.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate underline hover:text-zinc-950"
              title={m.name}
            >
              {m.name} ↗
            </a>
          ) : (
            <span className="min-w-0 flex-1 truncate" title={m.name}>
              {m.name}
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => choose(m.name)}
            className={`shrink-0 rounded-md border px-2 py-0.5 font-medium ${
              compact ? "text-[10px]" : "text-[11px]"
            } ${
              busy
                ? "cursor-not-allowed border-zinc-200 text-zinc-400"
                : "border-fuchsia-300 bg-white text-fuchsia-700 hover:bg-fuchsia-50"
            }`}
          >
            {choosing === m.name ? "Selecting…" : "Use this folder"}
          </button>
        </div>
      ))}
      {error ? <div className="text-[11px] text-red-600">{error}</div> : null}
    </div>
  );
}

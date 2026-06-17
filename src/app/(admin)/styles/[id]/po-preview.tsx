"use client";

import { useEffect, useRef, useState } from "react";

// Lazy PO preview. Nothing is fetched until the user clicks "Preview PO" — the
// PDF is streamed from SharePoint by /api/admin/styles/[id]/po-pdf (app-only
// Graph credentials), so no SharePoint login is needed. We fetch into a blob
// first (rather than pointing the iframe straight at the route) so we can show
// a real loading state and surface "PO PDF not found"-type errors instead of
// rendering the route's JSON error inside the frame.
type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; url: string }
  | { phase: "error"; message: string };

export function PoPreview({ styleId, poNumber }: { styleId: string; poNumber: string }) {
  const [state, setState] = useState<State>({ phase: "idle" });
  // Hold the object URL so we can revoke it on hide/unmount (no memory leak).
  const urlRef = useRef<string | null>(null);

  function revoke() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }

  useEffect(() => revoke, []); // revoke on unmount

  async function load() {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/po-pdf`);
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          // non-JSON body — keep the status-code message
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      revoke();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setState({ phase: "ready", url });
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  function hide() {
    revoke();
    setState({ phase: "idle" });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-zinc-600">
          PO <span className="font-medium text-zinc-800">{poNumber}</span>
        </div>
        {state.phase === "ready" ? (
          <button
            type="button"
            onClick={hide}
            className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Hide
          </button>
        ) : (
          <button
            type="button"
            onClick={load}
            disabled={state.phase === "loading"}
            className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
          >
            {state.phase === "loading" ? "Loading…" : "Preview PO"}
          </button>
        )}
      </div>

      {state.phase === "error" && (
        <div className="mt-2 text-xs text-red-600">Couldn’t load PO PDF: {state.message}</div>
      )}

      {state.phase === "ready" && (
        <iframe
          src={state.url}
          title={`PO ${poNumber}`}
          className="mt-3 h-[80vh] w-full rounded-md border border-zinc-200"
        />
      )}
    </div>
  );
}

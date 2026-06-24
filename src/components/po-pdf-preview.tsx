"use client";

import { useEffect, useRef, useState } from "react";

// Shared PO PDF preview popup. Lazily fetches the style's Purchase Order PDF
// (streamed from SharePoint by /api/admin/styles/[id]/po-pdf) into a blob and
// renders it in an iframe, with loading + error states. Used by the style
// header (PoPreview) and the /po-eans table (PoPdfLink), so the preview UI is
// identical everywhere.
const poPdfPath = (styleId: string) => `/api/admin/styles/${styleId}/po-pdf`;

export function PoPdfModal({
  styleId,
  poNumber,
  note,
  open,
  onClose,
}: {
  styleId: string;
  poNumber: string;
  // Optional sub-line in the header (e.g. a partial-match warning).
  note?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hold the object URL so we can revoke it on unmount (no memory leak).
  const urlRef = useRef<string | null>(null);
  // Fire the (lazy) fetch only once, on first open.
  const startedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Fetch into a blob the first time the popup opens, so we can show a loading
  // state and surface "PO PDF not found"-type errors instead of rendering the
  // route's JSON error inside the frame.
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(poPdfPath(styleId));
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
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setBlobUrl(url);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "request failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, styleId]);

  if (!open) return null;

  return (
    // Popup: click the backdrop or Close (or press Escape) to dismiss.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
          <div className="font-medium text-zinc-700">
            PO {poNumber}
            {note && <span className="ml-2 text-xs font-medium text-red-600">{note}</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
          >
            Close ✕
          </button>
        </div>
        <div className="relative flex-1 bg-zinc-100">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
              Loading PO PDF…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-red-600">
              Couldn&rsquo;t load PO PDF: {error}
            </div>
          )}
          {blobUrl && !error && (
            <iframe src={blobUrl} title={`PO ${poNumber}`} className="h-full w-full" />
          )}
        </div>
      </div>
    </div>
  );
}

// Compact trigger for tables/lists: the PO number rendered as a link that opens
// the shared preview popup.
export function PoPdfLink({
  styleId,
  poNumber,
  className,
}: {
  styleId: string;
  poNumber: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Preview PO PDF"
        className={
          className ??
          "tabular-nums text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
        }
      >
        {poNumber}
      </button>
      <PoPdfModal styleId={styleId} poNumber={poNumber} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

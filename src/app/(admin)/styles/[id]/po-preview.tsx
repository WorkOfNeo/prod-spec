"use client";

import { useEffect, useRef, useState } from "react";

// Lightweight PO surfacing for the style header: a prominent link to the PO,
// a button that previews it in a popup, and a button that opens it in a new
// tab. Both the link and the buttons hit /api/admin/styles/[id]/po-pdf, which
// streams the PDF from SharePoint on app-only Graph credentials — the viewer
// needs no SharePoint access. When the style's EAN match is only PARTIAL the
// preview button turns red and reads "Review PDF" to flag that it needs a
// human check.
const poPdfPath = (styleId: string) => `/api/admin/styles/${styleId}/po-pdf`;

export function PoPreview({
  styleId,
  poNumber,
  status,
}: {
  styleId: string;
  poNumber: string;
  status: string;
}) {
  const partial = status === "PARTIAL";
  const [open, setOpen] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hold the object URL so we can revoke it on unmount (no memory leak).
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Close the popup on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Fetch into a blob (lazily, the first time the popup opens) so we can show a
  // loading state and surface "PO PDF not found"-type errors instead of
  // rendering the route's JSON error inside the frame.
  async function openPopup() {
    setOpen(true);
    if (urlRef.current || loading) return; // already loaded or in flight
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
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setBlobUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  const linkCls = partial
    ? "font-semibold text-red-600 underline decoration-red-300 underline-offset-2 hover:text-red-700"
    : "font-semibold text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700";
  const previewBtnCls = partial
    ? "rounded-md border border-red-300 bg-red-50 px-3 py-1.5 font-medium text-red-700 hover:bg-red-100"
    : "rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="text-zinc-500">Purchase Order</span>
      <button type="button" onClick={openPopup} className={linkCls}>
        PO {poNumber}
      </button>
      <button type="button" onClick={openPopup} className={previewBtnCls}>
        {partial ? "Review PDF" : "Preview"}
      </button>
      <a
        href={poPdfPath(styleId)}
        target="_blank"
        rel="noreferrer"
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50"
      >
        Open in new tab ↗
      </a>

      {open && (
        // Popup: click the backdrop or Close (or press Escape) to dismiss.
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
              <div className="font-medium text-zinc-700">
                PO {poNumber}
                {partial && (
                  <span className="ml-2 text-xs font-medium text-red-600">
                    partial EAN match — please check
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
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
                  Couldn’t load PO PDF: {error}
                </div>
              )}
              {blobUrl && !error && (
                <iframe src={blobUrl} title={`PO ${poNumber}`} className="h-full w-full" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

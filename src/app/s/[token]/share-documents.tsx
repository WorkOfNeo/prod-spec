"use client";

import { useEffect, useState } from "react";

export type ShareDoc = {
  id: string;
  title: string;
  fileName: string;
  src: string;
};

// Supplier-facing document list. Each row opens the full PDF in a pop-up
// (modal) rather than rendering every PDF inline — keeps the page light and
// shows each document at full size when opened.
export function ShareDocuments({ documents }: { documents: ShareDoc[] }) {
  const [openDoc, setOpenDoc] = useState<ShareDoc | null>(null);

  // Close on Escape; lock body scroll while the modal is open.
  useEffect(() => {
    if (!openDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenDoc(null);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openDoc]);

  if (documents.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400">
        No approved documents on this link.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {documents.map((doc) => (
          <li key={doc.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setOpenDoc(doc)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <PdfIcon />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-zinc-800">{doc.title}</span>
                <span className="block truncate font-mono text-[10px] text-zinc-400">{doc.fileName}</span>
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setOpenDoc(doc)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
              >
                View
              </button>
              <a
                href={doc.src}
                download={doc.fileName}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
              >
                Download
              </a>
            </div>
          </li>
        ))}
      </ul>

      {openDoc ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 sm:p-6"
          onClick={() => setOpenDoc(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-zinc-900">{openDoc.title}</div>
                <div className="truncate font-mono text-[10px] text-zinc-400">{openDoc.fileName}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={openDoc.src}
                  download={openDoc.fileName}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setOpenDoc(null)}
                  aria-label="Close"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                >
                  Close
                </button>
              </div>
            </div>
            <iframe src={openDoc.src} title={openDoc.title} className="min-h-0 flex-1 bg-zinc-100" />
          </div>
        </div>
      ) : null}
    </>
  );
}

function PdfIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-5 w-5 shrink-0 text-zinc-400"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

"use client";

import { useState } from "react";
import { PoPdfModal } from "@/components/po-pdf-preview";

// Lightweight PO surfacing for the style header: a prominent link to the PO,
// a button that previews it in a popup (the shared PoPdfModal), and a button
// that opens it in a new tab. All hit /api/admin/styles/[id]/po-pdf, which
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

  const linkCls = partial
    ? "font-semibold text-red-600 underline decoration-red-300 underline-offset-2 hover:text-red-700"
    : "font-semibold text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700";
  const previewBtnCls = partial
    ? "rounded-md border border-red-300 bg-red-50 px-3 py-1.5 font-medium text-red-700 hover:bg-red-100"
    : "rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="text-zinc-500">Purchase Order</span>
      <button type="button" onClick={() => setOpen(true)} className={linkCls}>
        PO {poNumber}
      </button>
      <button type="button" onClick={() => setOpen(true)} className={previewBtnCls}>
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

      <PoPdfModal
        styleId={styleId}
        poNumber={poNumber}
        note={partial ? "partial EAN match — please check" : null}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

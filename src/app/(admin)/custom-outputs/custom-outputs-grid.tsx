"use client";

import { PreviewFrame } from "@/components/output-preview";

// One preview entry, prepared server-side in page.tsx. `html` is the full
// rendered template document (or null if rendering threw — then `error`
// carries the message).
export type OutputPreview = {
  key: string;
  name: string;
  description: string;
  docType: string;
  docTypeLabel: string;
  widthMm: number;
  heightMm: number;
  // Human labels of the resolved-spec fields this output needs to render.
  requiredFields: string[];
  html: string | null;
  error: string | null;
};

export function CustomOutputsGrid({ previews }: { previews: OutputPreview[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {previews.map((p) => (
        <OutputCard key={p.key} preview={p} />
      ))}
    </div>
  );
}

function OutputCard({ preview }: { preview: OutputPreview }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">{preview.name}</h3>
          <span className="flex-shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
            {preview.docTypeLabel}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{preview.description}</p>
        {preview.requiredFields.length > 0 && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
            <span className="font-medium text-zinc-500">Needs:</span>{" "}
            {preview.requiredFields.join(", ")}
          </p>
        )}
      </div>

      <div className="flex min-h-[18rem] items-center justify-center bg-zinc-100 p-5">
        {preview.html ? (
          <PreviewFrame
            html={preview.html}
            widthMm={preview.widthMm}
            heightMm={preview.heightMm}
          />
        ) : (
          <div className="max-w-full rounded-md border border-dashed border-red-300 bg-red-50 px-3 py-2 text-center text-xs text-red-600">
            Preview failed to render
            {preview.error ? <div className="mt-1 text-red-400">{preview.error}</div> : null}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-2 text-xs">
        <span className="text-zinc-400">
          {preview.widthMm} × {preview.heightMm} mm
        </span>
        <a
          href={`/api/admin/custom-outputs/preview?variantKey=${encodeURIComponent(preview.key)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-600 hover:text-zinc-900"
        >
          Open PDF ↗
        </a>
      </div>
    </div>
  );
}

// PreviewFrame (and its on-screen normalizer) moved to
// src/components/output-preview.tsx — shared with the style-page live
// preview cards and the ProdSpec editor's per-output previews.

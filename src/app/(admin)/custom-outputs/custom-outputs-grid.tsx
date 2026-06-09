"use client";

import { useEffect, useRef, useState } from "react";

// One preview entry, prepared server-side in page.tsx. `html` is the full
// rendered template document (or null if rendering threw — then `error`
// carries the message).
export type OutputPreview = {
  key: string;
  name: string;
  description: string;
  docType: string;
  widthMm: number;
  heightMm: number;
  // Human labels of the resolved-spec fields this output needs to render.
  requiredFields: string[];
  html: string | null;
  error: string | null;
};

// CSS px per mm at 100% zoom (96dpi). Used to size the iframe to the
// label's physical dimensions, then scale it down to fit the card.
const MM_TO_PX = 96 / 25.4;

const DOC_TYPE_LABELS: Record<string, string> = {
  WASHCARE: "Washcare",
  CARE_LABEL: "Care label",
  STICKER: "Sticker",
  HANGTAG: "Hangtag",
  CARTON_MARKING: "Carton marking",
  COLOUR_STICKER: "Colour sticker",
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
            {DOC_TYPE_LABELS[preview.docType] ?? preview.docType}
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

// Renders one template document in an iframe sized to the label's physical
// dimensions, then scales it down to fit the card width. The label's full
// rectangle (including whitespace) is shown so proportions are true to the
// printed output; multi-page templates stack their pages vertically.
function PreviewFrame({
  html,
  widthMm,
  heightMm,
}: {
  html: string;
  widthMm: number;
  heightMm: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const naturalW = widthMm * MM_TO_PX;
  const [scale, setScale] = useState(0);
  const [contentH, setContentH] = useState(heightMm * MM_TO_PX);

  // Fit the natural-width iframe into the available column width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(Math.min(w / naturalW, 1));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [naturalW]);

  // Measure the rendered content height so the wrapper hugs it (handles
  // single- and multi-page templates uniformly). Re-measure after a beat
  // to catch async webfont (barcode) reflow.
  const measure = () => {
    const doc = iframeRef.current?.contentDocument;
    const body = doc?.body;
    if (body) {
      setContentH(Math.max(body.scrollHeight, heightMm * MM_TO_PX));
    }
  };

  const scaledH = contentH * scale;

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden"
      style={{ height: scale > 0 ? scaledH : heightMm * MM_TO_PX }}
    >
      <div className="mx-auto bg-white shadow-md ring-1 ring-black/5" style={{ width: naturalW * scale, height: scaledH }}>
        <iframe
          ref={iframeRef}
          srcDoc={normalize(html, widthMm, heightMm)}
          onLoad={() => {
            measure();
            window.setTimeout(measure, 400);
          }}
          title="Output preview"
          scrolling="no"
          style={{
            width: naturalW,
            height: contentH,
            border: "none",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            background: "white",
            display: "block",
          }}
        />
      </div>
    </div>
  );
}

// Inject a small normalizer so the on-screen render matches the physical
// label box: the template's @page size is print-only and ignored on
// screen, so we pin body width to the label width and give every .page a
// min-height equal to the label height (lets flex `margin-top:auto`
// bottom-anchors resolve, and shows the full label rectangle).
function normalize(html: string, widthMm: number, heightMm: number): string {
  const css = `<style>html,body{margin:0;padding:0;background:#fff;width:${widthMm}mm;}body{min-height:${heightMm}mm;}.page{min-height:${heightMm}mm;}</style>`;
  return html.includes("</head>") ? html.replace("</head>", `${css}</head>`) : css + html;
}

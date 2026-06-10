"use client";

import { useState } from "react";

// Realistic preview of an output's most recently generated PDF: a small
// rasterised thumbnail (page 1, served by the thumbnail endpoint) that
// enlarges in a floating panel on hover and opens the actual PDF on click.
// Outputs that have never generated get an empty dashed frame instead.
export function OutputThumbnail({
  thumbSrc,
  href,
  name,
  generatedAt,
}: {
  thumbSrc: string | null;
  href: string | null;
  name: string;
  generatedAt: string | null;
}) {
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!thumbSrc || !href || failed) {
    return (
      <div
        title={failed ? "Preview unavailable" : "Not generated yet — no PDF to preview"}
        className="flex h-16 w-14 flex-shrink-0 items-center justify-center rounded border border-dashed border-zinc-200 bg-zinc-50"
      >
        <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-300">pdf</span>
      </div>
    );
  }

  // Anchor the zoom panel just right of the thumbnail, vertically centred on
  // it but clamped inside the viewport. Estimated panel height — the image
  // is capped at 420px + padding/caption — keeps the maths synchronous.
  function onEnter(e: React.MouseEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const PANEL_H = 470;
    const PANEL_W = 580;
    const x = Math.min(rect.right + 14, window.innerWidth - PANEL_W - 12);
    const y = Math.min(
      Math.max(rect.top + rect.height / 2 - PANEL_H / 2, 12),
      Math.max(window.innerHeight - PANEL_H - 12, 12)
    );
    setZoom({ x, y });
  }

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`${name}${generatedAt ? ` · generated ${generatedAt}` : ""} — click to open PDF`}
        onMouseEnter={onEnter}
        onMouseLeave={() => setZoom(null)}
        className={`block h-16 w-14 flex-shrink-0 overflow-hidden rounded border bg-white p-0.5 transition ${
          zoom ? "border-zinc-400 shadow-sm" : "border-zinc-200"
        } ${loaded ? "" : "animate-pulse bg-zinc-100"}`}
      >
        {/* Plain <img>: the source is a dynamic, auth-gated API route — not a
            static asset next/image could optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbSrc}
          alt={`${name} preview`}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`h-full w-full object-contain ${loaded ? "" : "opacity-0"}`}
        />
      </a>

      {zoom && (
        // pointer-events-none so the panel can never steal the hover from the
        // thumbnail and flicker.
        <div
          className="pointer-events-none fixed z-50"
          style={{ left: zoom.x, top: zoom.y }}
        >
          <div className="rounded-lg border border-zinc-300 bg-white p-2 shadow-2xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbSrc}
              alt=""
              className="max-h-[420px] max-w-[560px] rounded object-contain"
            />
            <div className="mt-1.5 flex items-baseline justify-between gap-4 px-0.5">
              <span className="truncate text-[11px] font-medium text-zinc-700">{name}</span>
              {generatedAt && (
                <span className="flex-shrink-0 text-[10px] text-zinc-400">
                  generated {generatedAt}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

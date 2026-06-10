"use client";

import { useEffect, useRef, useState } from "react";

// =====================================================
// Shared output-preview building blocks.
//
//   • PreviewFrame — renders a template HTML document in an iframe sized to
//     the label's physical mm dimensions, scaled to fit its container.
//     Lifted from /custom-outputs (the gallery imports it from here now).
//   • LazyOutputPreview — fetches preview HTML from an endpoint when the
//     card scrolls into view, then shows it in a PreviewFrame. Handles the
//     static-artwork (409) and error responses honestly.
// =====================================================

// CSS px per mm at 100% zoom (96dpi). Used to size the iframe to the
// label's physical dimensions, then scale it down to fit the card.
const MM_TO_PX = 96 / 25.4;

// Renders one template document in an iframe sized to the label's physical
// dimensions, then scales it down to fit the card width. The label's full
// rectangle (including whitespace) is shown so proportions are true to the
// printed output; multi-page templates stack their pages vertically.
export function PreviewFrame({
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
      <div
        className="mx-auto bg-white shadow-md ring-1 ring-black/5"
        style={{ width: naturalW * scale, height: scaledH }}
      >
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

type LazyState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "html"; html: string }
  | { kind: "static"; message: string }
  | { kind: "error"; message: string };

// Fetches `src` (a text/html preview endpoint) once the component becomes
// visible, then renders the result in a PreviewFrame. Re-fetches when
// `refreshKey` changes (the ProdSpec editor bumps it after each autosave).
export function LazyOutputPreview({
  src,
  widthMm,
  heightMm,
  refreshKey,
}: {
  src: string;
  widthMm: number;
  heightMm: number;
  refreshKey?: string | number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<LazyState>({ kind: "idle" });

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const res = await fetch(src, { cache: "no-store" });
        const contentType = res.headers.get("content-type") ?? "";
        if (res.ok && contentType.includes("text/html")) {
          const html = await res.text();
          if (!cancelled) setState({ kind: "html", html });
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          staticPdf?: boolean;
          message?: string;
          error?: string;
        };
        if (cancelled) return;
        if (res.status === 409 && body.staticPdf) {
          setState({
            kind: "static",
            message: body.message ?? "Static artwork passthrough — open the PDF to see the artifact.",
          });
        } else {
          setState({ kind: "error", message: body.error ?? `HTTP ${res.status}` });
        }
      } catch (e) {
        if (!cancelled) {
          setState({ kind: "error", message: e instanceof Error ? e.message : "Fetch failed" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, src, refreshKey]);

  return (
    <div ref={hostRef} className="w-full">
      {state.kind === "html" ? (
        <PreviewFrame html={state.html} widthMm={widthMm} heightMm={heightMm} />
      ) : state.kind === "static" ? (
        <div className="flex min-h-[8rem] items-center justify-center">
          <div className="max-w-full rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-zinc-500">
            {state.message}
          </div>
        </div>
      ) : state.kind === "error" ? (
        <div className="flex min-h-[8rem] items-center justify-center">
          <div className="max-w-full rounded-md border border-dashed border-red-300 bg-red-50 px-3 py-2 text-center text-xs text-red-600">
            Preview failed to render
            <div className="mt-1 text-red-400">{state.message}</div>
          </div>
        </div>
      ) : (
        <div
          className="flex items-center justify-center rounded-md bg-zinc-100/60 text-[11px] text-zinc-400"
          style={{ minHeight: "8rem" }}
        >
          {state.kind === "loading" ? "Rendering preview…" : "Preview loads when visible"}
        </div>
      )}
    </div>
  );
}

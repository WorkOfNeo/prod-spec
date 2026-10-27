"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

// A PDF proof drawn with pdf.js, so the zoom is ours to keep: the browser's
// built-in viewer (what an <iframe> of the PDF gives you) doesn't let the
// page read or set its zoom. The reviewer's choice — fit to width, or a
// percentage — is remembered in this browser and applied to every proof.

export type ProofZoom = "fit" | number;

const KEY = "ps-proof-zoom";
const MIN = 25;
const MAX = 500;
const STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

// Storage can be unavailable (private windows, blocked site data); the
// in-memory copy keeps the zoom for the visit either way.
let memory = "fit";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function parse(raw: string): ProofZoom {
  if (raw === "fit") return "fit";
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, Math.round(n))) : "fit";
}

/** The remembered proof zoom, and a setter that remembers it. */
export function useProofZoom(): [ProofZoom, (z: ProofZoom) => void] {
  // The server renders "fit"; the browser's stored choice takes over on hydration.
  const raw = useSyncExternalStore(subscribe, read, () => "fit");
  const set = (z: ProofZoom) => {
    memory = String(z === "fit" ? "fit" : Math.min(MAX, Math.max(MIN, Math.round(z))));
    try {
      window.localStorage.setItem(KEY, memory);
    } catch {
      // Not stored — the in-memory value still applies.
    }
    listeners.forEach((l) => l());
  };
  return [parse(raw), set];
}

/** The next zoom step in or out from a percentage. */
export function stepZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > current + 0.5) ?? MAX;
  return [...STEPS].reverse().find((s) => s < current - 0.5) ?? MIN;
}

// One worker for every proof on the page. It's handed to each document
// explicitly, so closing a document (switching outputs) leaves it running for
// the next one; a worker pdf.js creates itself is torn down with its document.
let sharedWorker: import("pdfjs-dist").PDFWorker | null = null;

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  if (!sharedWorker) {
    sharedWorker = pdfjs.PDFWorker.create({
      port: new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" }),
    });
  }
  return { pdfjs, worker: sharedWorker };
}

const PAD = 24; // around the pages, in CSS px

export function PdfProof({
  url,
  title,
  zoom,
  onZoomChange,
  onScale,
  className = "",
}: {
  url: string;
  title: string;
  zoom: ProofZoom;
  onZoomChange: (z: ProofZoom) => void;
  // The scale actually drawn, in percent — what "Fit" works out to.
  onScale?: (pct: number) => void;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const scaleRef = useRef(1);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;
    loadPdfjs()
      .then(async ({ pdfjs, worker }) => {
        const task = pdfjs.getDocument({ url, withCredentials: true, worker });
        destroy = () => void task.destroy();
        const d = await task.promise;
        if (!cancelled) {
          setError(null);
          setDoc(d);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the PDF");
      });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [url]);

  // Follow the box's width, for "fit".
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw every page at the current zoom.
  useEffect(() => {
    const host = pagesRef.current;
    const box = boxRef.current;
    if (!doc || !host || !box) return;
    // Measured here, not only from the observer: its first report can be late
    // (a background tab, a hidden pane), and the proof shouldn't wait for it.
    const avail = width || box.clientWidth;
    let cancelled = false;
    const tasks: RenderTask[] = [];
    (async () => {
      const first = await doc.getPage(1);
      const base = first.getViewport({ scale: 1 });
      const scale = zoom === "fit" ? Math.max(0.1, (avail - PAD * 2) / base.width) : zoom / 100;
      scaleRef.current = scale;
      onScale?.(Math.round(scale * 100));
      const dpr = window.devicePixelRatio || 1;
      const canvases: HTMLCanvasElement[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        if (cancelled) return;
        const page = n === 1 ? first : await doc.getPage(n);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        canvas.className = "block bg-white shadow-[var(--shadow-pop)]";
        canvas.setAttribute("aria-label", `${title}, page ${n} of ${doc.numPages}`);
        canvases.push(canvas);
        const task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
        tasks.push(task);
        await task.promise.catch(() => {});
      }
      if (!cancelled) host.replaceChildren(...canvases);
    })().catch(() => {});
    return () => {
      cancelled = true;
      tasks.forEach((t) => t.cancel());
    };
    // onScale is a callback for the label; redrawing on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, zoom, width, title]);

  // ⌘/Ctrl + scroll (and trackpad pinch, which arrives as ctrl + wheel) zooms.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const current = scaleRef.current * 100;
      const next = Math.min(MAX, Math.max(MIN, Math.round(current * Math.exp(-e.deltaY * 0.002))));
      if (next !== Math.round(current)) onZoomChange(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoomChange]);

  return (
    <div ref={boxRef} className={`bg-canvas overflow-auto ${className}`}>
      {error ? (
        <p className="text-bad p-6 text-[13px]">Couldn&rsquo;t show the PDF: {error}. Open PDF shows it in a new tab.</p>
      ) : !doc ? (
        <div className="p-6">
          <div className="skeleton mx-auto h-96 max-w-md rounded-md" aria-label="Loading the PDF" />
        </div>
      ) : null}
      <div ref={pagesRef} className="mx-auto flex w-max flex-col items-center gap-4" style={{ padding: PAD }} />
    </div>
  );
}

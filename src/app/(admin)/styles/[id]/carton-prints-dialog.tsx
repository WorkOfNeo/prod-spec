"use client";

import { useEffect, useState } from "react";
import { LazyOutputPreview } from "@/components/output-preview";

// MANUAL "X of Y" carton-numbered prints. A side action next to the
// per-output "Run": the standard output still generates normally; this
// lets an operator print a numbered set (1/N … N/N) on demand. The count
// is typed here (nothing in the system stores it), and the endpoint
// streams back ONE multi-page PDF — one carton per page — to print.
const CARTON_MAX = 2000;

export type CartonPrintsButtonProps = {
  styleId: string;
  variantKey: string;
  name: string;
  ready: boolean;
  widthMm: number;
  heightMm: number;
};

export function CartonPrintsButton(props: CartonPrintsButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!props.ready}
        onClick={() => setOpen(true)}
        title={props.ready ? "Print a numbered carton set (X of Y)" : "Output not ready yet"}
        className="flex-shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Carton numbers…
      </button>
      {open ? <CartonPrintsDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CartonPrintsDialog({
  styleId,
  variantKey,
  name,
  widthMm,
  heightMm,
  onClose,
}: CartonPrintsButtonProps & { onClose: () => void }) {
  const [total, setTotal] = useState(200);
  const [debouncedTotal, setDebouncedTotal] = useState(200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the preview so typing the count doesn't refetch per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedTotal(total), 350);
    return () => window.clearTimeout(t);
  }, [total]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const valid = Number.isInteger(total) && total >= 1 && total <= CARTON_MAX;
  const previewNo = Math.min(7, Math.max(1, debouncedTotal));
  const previewSrc =
    `/api/admin/styles/${styleId}/output-preview` +
    `?variantKey=${encodeURIComponent(variantKey)}` +
    `&cartonNo=${previewNo}&cartonTotal=${Math.max(1, debouncedTotal)}`;

  async function generate() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/carton-prints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKey, total }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Generation failed (${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^"]+)"?/.exec(cd);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m?.[1] ?? `cartons-1-${total}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-zinc-900">Generate carton-numbered prints</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{name}</p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="text-xs font-medium text-zinc-700">How many cartons?</label>
            <div className="mt-1.5 flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={CARTON_MAX}
                value={total}
                autoFocus
                onChange={(e) => setTotal(Math.floor(Number(e.target.value) || 0))}
                className="w-24 rounded-lg border border-zinc-300 px-3 py-2 text-center text-lg font-semibold tabular-nums text-zinc-900 focus:border-zinc-400 focus:outline-none"
              />
              <div className="text-xs text-zinc-500">
                prints{" "}
                <span className="font-semibold text-zinc-700">
                  1/{valid ? total : "…"} → {valid ? total : "…"}/{valid ? total : "…"}
                </span>
                <br />
                one page per carton
              </div>
            </div>
            {!valid ? (
              <p className="mt-1 text-[11px] text-red-600">
                Enter a whole number between 1 and {CARTON_MAX}.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              Live preview — carton {previewNo} of {Math.max(1, debouncedTotal)}
            </div>
            <div className="mx-auto" style={{ maxWidth: Math.max(widthMm * 3.4, 220) }}>
              <LazyOutputPreview
                src={previewSrc}
                widthMm={widthMm}
                heightMm={heightMm}
                refreshKey={`${previewNo}-${debouncedTotal}`}
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            One print-ready PDF, {valid ? total : "N"} pages — each numbered with{" "}
            <code className="rounded bg-zinc-100 px-1">{"{{cartonNo}}"}</code>/
            <code className="rounded bg-zinc-100 px-1">{"{{cartonTotal}}"}</code>. The standard output is
            unaffected.
          </p>

          {error ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={generate}
            disabled={!valid || busy}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate & download"}
          </button>
        </div>
      </div>
    </div>
  );
}

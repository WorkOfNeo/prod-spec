"use client";

import { useEffect, useState } from "react";
import { LazyOutputPreview } from "@/components/output-preview";
import { MAX_SIBLING_SLOTS } from "@/lib/output-layouts/token-meta";

// MANUAL carton prints. A side action next to the per-output "Run": the
// standard output still generates normally; this lets an operator print a
// numbered set (1/N … N/N) on demand AND compose a "Custom Carton Marking"
// — placing OTHER styles from the SAME PO on the box, exposed to the layout
// via {{style2}}/{{style3}}… slots. The count is typed here; the sibling
// pick is one-off for this print unless "made permanent" onto the ProdSpec
// output. The endpoint streams back ONE multi-page PDF — one carton per
// page — to print.
const CARTON_MAX = 2000;

type SiblingCandidate = {
  id: string;
  styleNumber: string;
  styleName: string;
  colourName: string;
  description: string;
};

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
        title={
          props.ready
            ? "Print a numbered carton set (X of Y) and/or place other styles from this PO on the box"
            : "Output not ready yet"
        }
        className="flex-shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Carton marking…
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

  // Custom Carton Marking — same-PO siblings to place on the box.
  const [siblings, setSiblings] = useState<SiblingCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Until the operator touches the selection, we send NOTHING about
  // siblings — preview + generate fall back to the output's saved
  // (permanent) slot policy. Pre-selection from that policy keeps the
  // checkboxes matching the preview without counting as "touched".
  const [touched, setTouched] = useState(false);
  const [siblingsLoaded, setSiblingsLoaded] = useState(false);

  // "Make permanent" state.
  const [permBusy, setPermBusy] = useState(false);
  const [permMsg, setPermMsg] = useState<string | null>(null);

  // Debounce the preview so typing the count doesn't refetch per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedTotal(total), 350);
    return () => window.clearTimeout(t);
  }, [total]);

  // Load the same-PO sibling candidates + this output's permanent policy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/styles/${styleId}/po-siblings?variantKey=${encodeURIComponent(variantKey)}`,
        );
        if (!res.ok) throw new Error();
        const j = (await res.json()) as {
          siblings?: SiblingCandidate[];
          permanent?: { enabled?: boolean; slots?: number } | null;
        };
        if (cancelled) return;
        const list = j.siblings ?? [];
        setSiblings(list);
        // Pre-select the inherited siblings (first slots-1) so the dialog
        // mirrors what already prints for this output.
        if (j.permanent?.enabled) {
          const want = Math.max(0, (j.permanent.slots ?? 2) - 1);
          setSelectedIds(list.slice(0, want).map((s) => s.id));
        }
      } catch {
        // Non-fatal: the dialog still does plain X-of-Y without siblings.
      } finally {
        if (!cancelled) setSiblingsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [styleId, variantKey]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleSibling(id: string) {
    setTouched(true);
    setPermMsg(null);
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const valid = Number.isInteger(total) && total >= 1 && total <= CARTON_MAX;
  const previewNo = Math.min(7, Math.max(1, debouncedTotal));
  // Only steer the preview's siblings once touched — otherwise let the
  // output's permanent policy drive it (param omitted).
  const siblingQuery = touched ? `&siblingIds=${selectedIds.join(",")}` : "";
  const previewSrc =
    `/api/admin/styles/${styleId}/output-preview` +
    `?variantKey=${encodeURIComponent(variantKey)}` +
    `&cartonNo=${previewNo}&cartonTotal=${Math.max(1, debouncedTotal)}` +
    siblingQuery;

  async function generate() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/carton-prints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantKey,
          total,
          // Omit unless touched so the saved permanent policy applies.
          ...(touched ? { siblingIds: selectedIds } : {}),
        }),
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

  // Persist the BEHAVIOUR (slot count) onto the ProdSpec output so every
  // style on that prod spec inherits the multi-style carton marking.
  async function makePermanent() {
    if (permBusy) return;
    setPermBusy(true);
    setPermMsg(null);
    try {
      const slots = Math.min(selectedIds.length + 1, MAX_SIBLING_SLOTS);
      const res = await fetch(`/api/admin/styles/${styleId}/custom-carton-marking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKey, enabled: true, slots }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; slots?: number };
      if (!res.ok) throw new Error(j.error ?? `Failed (${res.status})`);
      setPermMsg(
        `Saved — every style on this prod spec now prints ${j.slots ?? slots} styles on the box.`,
      );
    } catch (e) {
      setPermMsg(e instanceof Error ? e.message : "Could not save");
    } finally {
      setPermBusy(false);
    }
  }

  const selectedSet = new Set(selectedIds);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-zinc-900">Carton marking prints</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{name}</p>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
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

          {/* Custom Carton Marking — other styles from the same PO. */}
          <div className="border-t border-zinc-100 pt-3">
            <div className="flex items-baseline justify-between">
              <label className="text-xs font-medium text-zinc-700">
                Other styles on the box{" "}
                <span className="font-normal text-zinc-400">(same PO)</span>
              </label>
              {selectedIds.length > 0 && (
                <span className="text-[11px] tabular-nums text-zinc-500">
                  {selectedIds.length + 1} styles
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
              Tick to fill the{" "}
              <code className="rounded bg-zinc-100 px-1">{"{{style2}}"}</code>,{" "}
              <code className="rounded bg-zinc-100 px-1">{"{{style3}}"}</code>… slots. Order = slot
              order.
            </p>
            <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
              {!siblingsLoaded ? (
                <p className="text-[11px] text-zinc-400">Loading…</p>
              ) : siblings.length === 0 ? (
                <p className="text-[11px] text-zinc-400">No other styles on this PO.</p>
              ) : (
                siblings.map((s) => {
                  const slot = selectedIds.indexOf(s.id);
                  const checked = selectedSet.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleSibling(s.id)}
                      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition ${
                        checked
                          ? "border-amber-300 bg-amber-50"
                          : "border-zinc-200 bg-white hover:bg-zinc-50"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[9px] font-bold ${
                          checked
                            ? "border-amber-500 bg-amber-500 text-white"
                            : "border-zinc-300 bg-white text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold text-zinc-800">
                          {s.styleNumber || s.styleName || s.id}
                        </span>
                        {s.colourName ? <span className="text-zinc-500"> · {s.colourName}</span> : null}
                        {s.styleName && s.styleNumber ? (
                          <span className="text-zinc-400"> · {s.styleName}</span>
                        ) : null}
                      </span>
                      {checked && (
                        <span className="flex-shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-800">
                          {`{{style${slot + 2}}}`}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
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
                refreshKey={`${previewNo}-${debouncedTotal}-${touched ? selectedIds.join(",") : "perm"}`}
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            One print-ready PDF, {valid ? total : "N"} pages — each numbered with{" "}
            <code className="rounded bg-zinc-100 px-1">{"{{cartonNo}}"}</code>/
            <code className="rounded bg-zinc-100 px-1">{"{{cartonTotal}}"}</code>. The standard output is
            unaffected.
          </p>

          {/* Make permanent — persists the slot count to the ProdSpec output. */}
          {selectedIds.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-zinc-700">
                    Make permanent for this output?
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                    Saves a {selectedIds.length + 1}-style carton marking on this prod spec — every
                    style inherits the slots (siblings resolved per PO, not these exact styles).
                  </div>
                </div>
                <button
                  type="button"
                  onClick={makePermanent}
                  disabled={permBusy}
                  className="flex-shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  {permBusy ? "Saving…" : "Make permanent"}
                </button>
              </div>
              {permMsg && <p className="mt-2 text-[11px] text-zinc-600">{permMsg}</p>}
            </div>
          )}

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

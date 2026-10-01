"use client";

import { useMemo, useState } from "react";
import type { BoardPo } from "@/lib/carton-groups/board";

// "Multiple styles in Carton" — a three-step wizard.
//
// Written for reviewers who follow instructions rather than infer them, so:
//  • one decision per step, in the order the decision has to be made;
//  • Next is disabled until the step is actually answerable, and the footer
//    says WHY in words rather than leaving a dead button;
//  • step 2 shows the resulting carton barcode read-only, so the consequence of
//    picking a main style is visible without having to understand slots;
//  • step 3 lists what will happen, including the fact that the markings that
//    already exist are NOT touched.
//
// The carton barcode is not a field. It is the main style's {{cartonEan}},
// exactly as today's carton dialog behaves — a barcode cannot be invented, its
// number range belongs to the customer.

const MAX_STYLES = 8;

export function MultiStyleCartonDialog({
  po,
  onClose,
  onCreated,
}: {
  po: BoardPo;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(1);
  const [picked, setPicked] = useState<string[]>([]);
  const [mainId, setMainId] = useState<string | null>(null);
  const [totalCartons, setTotalCartons] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One entry per style on the PO. Styles are keyed by styleId — a style with
  // several carton outputs must not appear twice in the picker.
  const candidates = useMemo(() => {
    const seen = new Map<string, (typeof po.styles)[number]>();
    for (const s of po.styles) if (!seen.has(s.styleId)) seen.set(s.styleId, s);
    return [...seen.values()];
  }, [po]);

  const pickedStyles = picked.flatMap((id) => {
    const hit = candidates.find((c) => c.styleId === id);
    return hit ? [hit] : [];
  });
  const main = pickedStyles.find((s) => s.styleId === mainId) ?? null;

  function toggle(styleId: string) {
    setPicked((prev) => {
      if (prev.includes(styleId)) {
        if (mainId === styleId) setMainId(null);
        return prev.filter((id) => id !== styleId);
      }
      if (prev.length >= MAX_STYLES) {
        window.alert(`A carton marking can hold at most ${MAX_STYLES} styles.`);
        return prev;
      }
      return [...prev, styleId];
    });
  }

  async function create() {
    if (!main) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/carton-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mainStyleId: main.styleId,
          otherStyleIds: picked.filter((id) => id !== main.styleId),
          variantKey: main.variantKey,
          totalCartons: Number(totalCartons) > 1 ? Number(totalCartons) : null,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not create the carton marking.");
        return;
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the carton marking.");
    } finally {
      setBusy(false);
    }
  }

  const canNext = step === 1 ? picked.length >= 2 : step === 2 ? Boolean(mainId) : true;
  const hint =
    step === 1
      ? picked.length < 2
        ? `Tick at least 2 styles (${picked.length} ticked)`
        : `${picked.length} styles ticked`
      : step === 2 && !mainId
        ? "Choose the main style"
        : "";

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black/45 p-7">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h3 className="text-lg font-semibold">Multiple styles in Carton — PO {po.poNumber}</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Use this when two or more styles from this PO are packed into the{" "}
            <b>same physical carton</b>. We make one extra shared carton marking. The markings you
            already have stay exactly as they are.
          </p>
        </div>

        <div className="flex border-b border-zinc-200 px-6">
          {["Pick the styles", "Choose the main style", "Check & create"].map((label, i) => {
            const n = i + 1;
            return (
              <div
                key={label}
                className={`mr-7 flex items-center gap-2 border-b-2 py-3 text-sm font-semibold ${
                  step === n
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-400"
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    step === n
                      ? "bg-zinc-900 text-white"
                      : step > n
                        ? "bg-green-700 text-white"
                        : "bg-zinc-200 text-zinc-500"
                  }`}
                >
                  {n}
                </span>
                {label}
              </div>
            );
          })}
        </div>

        <div className="max-h-[60vh] overflow-auto px-6 py-5">
          {step === 1 && (
            <>
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                <b>Tick every style that goes into the same box.</b> You must tick at least 2, and
                at most {MAX_STYLES}. Only styles from this PO are shown — if a style is missing
                here, it has a different PO number.
              </div>
              {candidates.map((s) => {
                const on = picked.includes(s.styleId);
                return (
                  <button
                    type="button"
                    key={s.styleId}
                    onClick={() => toggle(s.styleId)}
                    className={`mb-2 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left ${
                      on ? "border-zinc-900 bg-slate-50" : "border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    <input type="checkbox" readOnly checked={on} className="h-4 w-4" />
                    <span className="flex-1">
                      <span className="block font-semibold">
                        {s.styleNumber || s.styleName} — {s.styleName}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        Colour {s.colourName || "—"} · carton barcode{" "}
                        <span className="font-mono">{s.cartonEan ?? "none"}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {step === 2 && (
            <>
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                The <b>main style</b> is printed first on the marking, and{" "}
                <b>its carton barcode is the one used</b>. Pick the style the supplier and the
                customer think of as the main one in the box.
              </div>
              {pickedStyles.map((s) => (
                <button
                  type="button"
                  key={s.styleId}
                  onClick={() => setMainId(s.styleId)}
                  className={`mb-2 flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left ${
                    mainId === s.styleId
                      ? "border-violet-700 bg-violet-50"
                      : "border-zinc-200 hover:bg-zinc-50"
                  }`}
                >
                  <input
                    type="radio"
                    readOnly
                    checked={mainId === s.styleId}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <span className="block font-semibold">
                      {s.styleNumber || s.styleName} — {s.colourName || "no colour"}
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      Carton barcode used would be{" "}
                      <span className="font-mono">{s.cartonEan ?? "none on this style"}</span>
                    </span>
                  </span>
                </button>
              ))}

              <div className="mt-5">
                <label
                  htmlFor="total-cartons"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-600"
                >
                  Total number of cartons (optional)
                </label>
                <input
                  id="total-cartons"
                  type="text"
                  inputMode="numeric"
                  value={totalCartons}
                  onChange={(e) => setTotalCartons(e.target.value.replace(/\D+/g, ""))}
                  placeholder="e.g. 8"
                  className="w-28 rounded-md border border-zinc-300 px-3 py-2 text-center text-sm"
                />
                <p className="mt-1.5 text-xs text-zinc-500">
                  Only fill this in if the marking prints “Carton 1 of 8”. Leave it empty if it
                  does not.
                </p>
              </div>
            </>
          )}

          {step === 3 && main && (
            <>
              <div className="overflow-hidden rounded-lg border border-zinc-200">
                <SummaryRow k="PO">
                  <b>{po.poNumber}</b> · {po.customerName} · {po.supplierName ?? "no supplier"}
                </SummaryRow>
                <SummaryRow k="Styles in this carton">
                  {pickedStyles.map((s) => (
                    <div key={s.styleId}>
                      {s.styleNumber || s.styleName} {s.colourName}
                      {s.styleId === main.styleId ? <b> (main)</b> : null}
                    </div>
                  ))}
                </SummaryRow>
                <SummaryRow k="Carton barcode">
                  <span className="font-mono">{main.cartonEan ?? "none on the main style"}</span>{" "}
                  <span className="text-zinc-500">— from the main style</span>
                </SummaryRow>
                <SummaryRow k="Total cartons">
                  {Number(totalCartons) > 1 ? totalCartons : "not printed"}
                </SummaryRow>
                <SummaryRow k="Existing markings">
                  Unchanged — all {po.styles.length} stay as they are
                </SummaryRow>
              </div>

              <p className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-600">
                When you click Create, this happens
              </p>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-zinc-700">
                <li>A new multi-style carton marking is generated for this PO.</li>
                <li>
                  It appears in the PO as a purple card, with status <b>Pending review</b>.
                </li>
                <li>
                  Each style you ticked gets a purple badge, so anyone can see it is part of a
                  shared carton.
                </li>
                <li>
                  <b>The carton markings you already have are not touched.</b> They stay approved
                  and stay in SharePoint.
                </li>
                <li>When you approve the new one, it is uploaded like any other output.</li>
              </ol>

              <div className="mt-4 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900">
                <b>Nothing is deleted and nothing is replaced.</b> If you make a mistake you can
                click <b>Ungroup</b> on the purple card afterwards.
              </div>

              {error && (
                <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-zinc-200 bg-zinc-50 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-100"
          >
            Cancel
          </button>
          <div className="flex-1" />
          {hint && <span className="text-xs text-zinc-500">{hint}</span>}
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-100"
            >
              Back
            </button>
          )}
          {step < 3 ? (
            <button
              type="button"
              disabled={!canNext}
              onClick={() => setStep(step + 1)}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !main}
              onClick={() => void create()}
              className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create carton marking"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex border-b border-zinc-100 px-4 py-2.5 text-sm last:border-b-0">
      <div className="w-52 shrink-0 text-zinc-500">{k}</div>
      <div>{children}</div>
    </div>
  );
}

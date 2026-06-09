"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/ui/combobox";

type Customer = { id: string; name: string };
type BusinessArea = { id: string; mondayValue: string; name: string };
type Pair = { customerId: string; businessAreaId: string };

export function NewProdSpecButton({
  customers,
  businessAreas,
  existingPairs,
}: {
  customers: Customer[];
  businessAreas: BusinessArea[];
  // Existing (Customer × BA) pairs — used to disable combos that would
  // hit the unique constraint on submit. Operators can only pick combos
  // that *fit*.
  existingPairs: Pair[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [businessAreaIds, setBusinessAreaIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneSummary, setDoneSummary] = useState<string | null>(null);

  // Pair-lookup set so the BA combobox can disable already-used BAs for
  // the selected customer in O(1).
  const usedBaIdsByCustomer = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of existingPairs) {
      let s = m.get(p.customerId);
      if (!s) {
        s = new Set();
        m.set(p.customerId, s);
      }
      s.add(p.businessAreaId);
    }
    return m;
  }, [existingPairs]);

  function reset() {
    setCustomerId(null);
    setBusinessAreaIds([]);
    setErr(null);
    setDoneSummary(null);
  }

  function close() {
    if (busy) return;
    setOpen(false);
    reset();
  }

  // Customer option list — every active customer; hint shows how many BAs
  // already link vs total (so operators see who's still under-specced).
  const customerOptions = useMemo(() => {
    return customers.map((c) => {
      const usedCount = usedBaIdsByCustomer.get(c.id)?.size ?? 0;
      const totalCount = businessAreas.length;
      const allUsed = totalCount > 0 && usedCount === totalCount;
      return {
        value: c.id,
        label: c.name,
        hint: allUsed
          ? "all BAs linked"
          : usedCount > 0
            ? `${usedCount}/${totalCount} BAs`
            : undefined,
        disabled: allUsed,
        disabledReason: allUsed
          ? "Every active business area already has a ProdSpec for this customer."
          : undefined,
      };
    });
  }, [customers, businessAreas.length, usedBaIdsByCustomer]);

  // BA options for the *currently selected* customer. Disabled rows are
  // BAs that already pair with this customer — they remain visible so the
  // operator sees what's already covered.
  const baOptions = useMemo(() => {
    const used = customerId
      ? (usedBaIdsByCustomer.get(customerId) ?? new Set<string>())
      : new Set<string>();
    return businessAreas.map((b) => {
      const isUsed = used.has(b.id);
      return {
        value: b.id,
        label: b.name,
        hint: isUsed
          ? "already linked"
          : b.mondayValue !== b.name
            ? b.mondayValue
            : undefined,
        disabled: isUsed,
        disabledReason: isUsed
          ? `A ProdSpec already exists for this customer × ${b.name}.`
          : undefined,
      };
    });
  }, [businessAreas, customerId, usedBaIdsByCustomer]);

  async function save() {
    if (!customerId || businessAreaIds.length === 0) return;
    setBusy(true);
    setErr(null);
    setDoneSummary(null);
    try {
      // Always send the batch shape — works for 1 BA or N. The API
      // back-fills Style.prodSpecId for each pair.
      const res = await fetch("/api/admin/prod-specs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, businessAreaIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const created: Array<{ prodSpec: { id: string; name: string }; backfilledStyles: number }> =
        body.created ?? [];
      const failed: Array<{ businessAreaId: string; error: string }> = body.failed ?? [];

      // Jump straight into the editor for a single-row create. Otherwise
      // refresh the list and show a summary in the dialog.
      if (created.length === 1 && failed.length === 0) {
        router.push(`/prod-specs/${created[0].prodSpec.id}`);
        router.refresh();
        return;
      }

      const totalBackfilled = created.reduce((s, c) => s + c.backfilledStyles, 0);
      setDoneSummary(
        `Created ${created.length} prod spec${created.length === 1 ? "" : "s"}` +
          (totalBackfilled > 0
            ? `, back-filled ${totalBackfilled} style${totalBackfilled === 1 ? "" : "s"}`
            : "") +
          (failed.length > 0 ? ` · ${failed.length} failed` : ""),
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const disabledTrigger = customers.length === 0 || businessAreas.length === 0;
  const canSubmit = !!customerId && businessAreaIds.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabledTrigger}
        title={
          disabledTrigger
            ? "Need at least one Customer and one Business Area to create a ProdSpec"
            : "Create one or more ProdSpecs"
        }
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        + New prod spec
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-start justify-between">
              <h2 className="text-lg font-semibold">New prod spec</h2>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="text-xs text-zinc-500 underline disabled:opacity-50"
              >
                close
              </button>
            </div>

            <label htmlFor="ps-customer" className="block text-xs font-medium text-zinc-700">
              Customer *
              <div className="mt-1">
                <Combobox
                  id="ps-customer"
                  mode="single"
                  options={customerOptions}
                  value={customerId}
                  onChange={(v) => {
                    setCustomerId(v);
                    // Reset BA selection when the customer changes — the
                    // disabled set just shifted under the user.
                    setBusinessAreaIds([]);
                  }}
                  placeholder="Search customers…"
                  emptyLabel="No matching customers"
                />
              </div>
            </label>

            <label className="mt-4 block text-xs font-medium text-zinc-700">
              Business area{businessAreaIds.length > 1 ? "s" : ""} *
              <div className="mt-1">
                <Combobox
                  mode="multi"
                  options={baOptions}
                  value={businessAreaIds}
                  onChange={setBusinessAreaIds}
                  placeholder={
                    customerId ? "Pick one or more…" : "Pick a customer first"
                  }
                  emptyLabel="No matching business areas"
                  disabled={!customerId}
                />
              </div>
              <span className="mt-1 block font-normal text-zinc-500">
                Pick multiple to create one ProdSpec per pair in a single click. Already-linked
                combos appear greyed.
              </span>
            </label>

            {doneSummary && (
              <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {doneSummary}
              </p>
            )}

            {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {doneSummary ? "Done" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !canSubmit}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy
                  ? "Creating…"
                  : businessAreaIds.length > 1
                    ? `Create ${businessAreaIds.length}`
                    : "Create & edit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

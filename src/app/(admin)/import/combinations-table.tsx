"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { NewCombination } from "@/lib/import/scan";

type AcceptResponse = {
  prodSpecId: string;
  backfilledStyles: number;
  promoted: number;
  alreadyExisted: number;
  jobsEnqueued: number;
  failures: Array<{ ghostItemId: string; error: string }>;
};

export function CombinationsTable({ combinations }: { combinations: NewCombination[] }) {
  const router = useRouter();
  // Map key: "customerId::businessAreaId"
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);

  if (combinations.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
        No new combinations detected. New (customer × business area) pairs land here as ghost
        data syncs.
      </div>
    );
  }

  async function accept(customerId: string, businessAreaId: string, customerName: string, baName: string) {
    const key = `${customerId}::${businessAreaId}`;
    setBusy(key);
    setToast(null);
    try {
      const res = await fetch("/api/admin/import/combinations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, businessAreaId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setToast({ kind: "err", message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as AcceptResponse;
      const parts = [
        `ProdSpec created: ${customerName} · ${baName}`,
        `${body.promoted} item${body.promoted === 1 ? "" : "s"} imported`,
        `${body.jobsEnqueued} job${body.jobsEnqueued === 1 ? "" : "s"} queued`,
      ];
      if (body.backfilledStyles > 0) {
        parts.push(`${body.backfilledStyles} backfilled`);
      }
      if (body.failures.length > 0) {
        parts.push(`${body.failures.length} failed`);
      }
      setToast({ kind: "ok", message: parts.join(" · ") });
      router.refresh();
    } catch (err) {
      setToast({ kind: "err", message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {toast && (
        <div
          className={`border-b px-4 py-2 text-sm ${
            toast.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {toast.message}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Business area</th>
            <th className="px-4 py-3">Matches</th>
            <th className="px-4 py-3">Sample items</th>
            <th className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {combinations.map((c) => {
            const key = `${c.customerId}::${c.businessAreaId}`;
            const isBusy = busy === key;
            return (
              <tr key={key} className="border-t border-zinc-100 hover:bg-zinc-50">
                <td className="px-4 py-3 font-medium">{c.customerName}</td>
                <td className="px-4 py-3 text-zinc-600">{c.businessAreaName}</td>
                <td className="px-4 py-3 text-zinc-600 tabular-nums">
                  {c.matchCount}
                  {c.ambiguousCount > 0 && (
                    <span className="ml-1 text-xs text-zinc-400">
                      (+{c.ambiguousCount} ambiguous)
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  {c.sampleItems.slice(0, 3).join(" · ") || "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      accept(c.customerId, c.businessAreaId, c.customerName, c.businessAreaName)
                    }
                    disabled={busy !== null}
                    className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {isBusy ? "Accepting…" : "Accept"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

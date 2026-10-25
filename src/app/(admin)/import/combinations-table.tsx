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
      <div className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
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
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {toast && (
        <div
          className={`border-b px-4 py-2 text-sm ${
            toast.kind === "ok"
              ? "border-transparent bg-good-soft text-good"
              : "border-transparent bg-bad-soft text-bad"
          }`}
        >
          {toast.message}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Business area</th>
            <th className="px-3 py-2">Matches</th>
            <th className="px-3 py-2">Sample items</th>
            <th className="px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {combinations.map((c) => {
            const key = `${c.customerId}::${c.businessAreaId}`;
            const isBusy = busy === key;
            return (
              <tr key={key} className="border-t border-line hover:bg-subtle">
                <td className="px-3 py-2 font-medium">{c.customerName}</td>
                <td className="px-3 py-2 text-muted">{c.businessAreaName}</td>
                <td className="px-3 py-2 text-muted tabular-nums">
                  {c.matchCount}
                  {c.ambiguousCount > 0 && (
                    <span className="ml-1 text-xs text-faint">
                      (+{c.ambiguousCount} ambiguous)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted">
                  {c.sampleItems.slice(0, 3).join(" · ") || "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      accept(c.customerId, c.businessAreaId, c.customerName, c.businessAreaName)
                    }
                    disabled={busy !== null}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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

"use client";

// Admin-only "Styles awaiting approval" card for the ProdSpec editor's General
// tab. Retroactive bulk-approve: after a spec is marked trusted, styles that
// were generated earlier can still be sitting unapproved in review. This lists
// those styles (latest job AWAITING_REVIEW) and approves them — one by one or
// all at once — through the SAME publish path as the review screen's
// "Approve all & publish" button (POST .../approve-styles → publishApprovedJob).

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AwaitingApprovalStyle = {
  id: string;
  name: string;
  poNumber: string | null;
  outputCount: number;
  pendingCount: number;
};

type StyleResult = {
  styleId: string;
  name: string;
  status: "approved" | "blocked" | "skipped";
  detail?: string;
};

type ApproveResponse = {
  ok: true;
  results: StyleResult[];
  approved: number;
  blocked: number;
  skipped: number;
};

export function ApproveStylesPanel({
  prodSpecId,
  styles,
}: {
  prodSpecId: string;
  styles: AwaitingApprovalStyle[];
}) {
  const router = useRouter();
  const base = `/api/admin/prod-specs/${prodSpecId}/approve-styles`;

  // "all" while an approve-all run is in flight, otherwise the styleId being
  // approved on its own. Null = idle.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ApproveResponse | null>(null);

  if (styles.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-xs text-zinc-500">
        No styles awaiting approval on this prod spec.
      </div>
    );
  }

  async function approve(styleIds: string[] | null) {
    if (busy) return;
    setBusy(styleIds && styleIds.length === 1 ? styleIds[0] : "all");
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(styleIds && styleIds.length > 0 ? { styleIds } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ApproveResponse> & {
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSummary(data as ApproveResponse);
      // Reload the server component so the list reflects the just-approved
      // styles (they drop out) and any spec badges refresh.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const runningAll = busy === "all";

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800">Styles awaiting approval</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Styles generated earlier and still sitting in review. Approving runs the same publish
            path as the review screen — cascades outputs to approved, uploads to SharePoint and
            notifies the supplier.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void approve(null)}
          disabled={busy != null}
          title="Approve every style awaiting approval on this prod spec"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {runningAll && <Spinner />}
          {runningAll ? "Approving…" : `Approve all (${styles.length})`}
        </button>
      </div>

      <ul className="mt-3 divide-y divide-zinc-100 overflow-hidden rounded-md border border-zinc-200 bg-white">
        {styles.map((s) => {
          const rowBusy = busy === s.id;
          return (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-zinc-800">{s.name}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {s.poNumber ? `PO ${s.poNumber}` : "No PO"} · {s.outputCount} output
                  {s.outputCount === 1 ? "" : "s"}
                  {s.pendingCount > 0 ? ` · ${s.pendingCount} pending` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void approve([s.id])}
                disabled={busy != null}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {rowBusy && <Spinner />}
                {rowBusy ? "Approving…" : "Approve"}
              </button>
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
          {error}
        </p>
      )}

      {summary && (
        <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-900">
          <p className="font-medium">
            ✓ {summary.approved} approved
            {summary.blocked > 0 ? ` · ${summary.blocked} blocked` : ""}
            {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ""}
          </p>
          {(summary.blocked > 0 || summary.skipped > 0) && (
            <ul className="mt-1 space-y-0.5 text-emerald-800">
              {summary.results
                .filter((r) => r.status !== "approved")
                .map((r) => (
                  <li key={r.styleId} className="truncate">
                    {r.name} — {r.detail ?? r.status}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 animate-spin text-current"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

"use client";

// Admin-only "Styles & approval" card for the ProdSpec editor's General tab.
// Lists EVERY live style on this prod spec, grouped by supplier, with a
// cross-job "outputs ready" rollup per style (same slot numbers the review
// page shows). Approving — per style, per supplier group, or all at once —
// runs the SAME publish path as the review screen's "Approve all & publish"
// button (POST .../approve-styles → publishApprovedJob): outputs cascade to
// approved, upload to SharePoint AND the supplier's own folder, and queue for
// the nightly supplier email.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type ApprovalPanelStyle = {
  id: string;
  name: string;
  poNumber: string | null;
  supplierName: string | null;
  // Latest job AWAITING_REVIEW — the retroactive bulk publish path applies.
  // Styles whose pending outputs sit on older runs are decided from the
  // review page instead.
  approvable: boolean;
  toApprove: number; // TO_REVIEW slots — what approving would decide
  approved: number;
  blocked: number; // placeholder ship-gate — needs a data fix + re-run
  rejected: number;
  coming: number; // awaiting data / ready to generate / generating
  excluded: number; // doc-type rule or operator ignore — decided, never ships
  total: number; // declared output slots
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
  totalCount,
}: {
  prodSpecId: string;
  styles: ApprovalPanelStyle[];
  // Live styles on the spec in total — greater than styles.length when the
  // list was capped, so the cap is visible instead of reading as "everything".
  totalCount: number;
}) {
  const router = useRouter();
  const base = `/api/admin/prod-specs/${prodSpecId}/approve-styles`;

  // "all", "group:<supplier>" or the styleId being approved. Null = idle.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ApproveResponse | null>(null);

  const groups = useMemo(() => {
    const bySupplier = new Map<string, ApprovalPanelStyle[]>();
    for (const s of styles) {
      const key = s.supplierName?.trim() || "";
      const arr = bySupplier.get(key) ?? [];
      arr.push(s);
      bySupplier.set(key, arr);
    }
    return [...bySupplier.entries()]
      .map(([supplier, rows]) => ({
        supplier: supplier || null,
        rows,
        approvableIds: rows.filter((r) => r.approvable).map((r) => r.id),
        readyOutputs: rows.reduce((n, r) => n + r.toApprove, 0),
      }))
      // Named suppliers alphabetically, "no supplier" last.
      .sort((a, b) => {
        if (a.supplier == null) return b.supplier == null ? 0 : 1;
        if (b.supplier == null) return -1;
        return a.supplier.localeCompare(b.supplier);
      });
  }, [styles]);

  const approvableCount = useMemo(() => styles.filter((s) => s.approvable).length, [styles]);

  if (styles.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-xs text-zinc-500">
        No styles on this prod spec yet.
      </div>
    );
  }

  async function approve(styleIds: string[] | null, busyKey: string) {
    if (busy) return;
    setBusy(busyKey);
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
      // Reload the server component so the rollups reflect the just-approved
      // styles and any spec badges refresh.
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
          <p className="text-sm font-medium text-zinc-800">Styles & approval</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            All live styles on this prod spec, grouped by supplier, with each style&apos;s
            outputs ready for approval. Approving runs the same publish path as the review
            screen — outputs cascade to approved, upload to SharePoint and the supplier&apos;s
            own folder, and queue for the nightly supplier email.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void approve(null, "all")}
          disabled={busy != null || approvableCount === 0}
          title={
            approvableCount === 0
              ? "No style is awaiting approval right now"
              : "Approve every style awaiting approval on this prod spec"
          }
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {runningAll && <Spinner />}
          {runningAll ? "Approving…" : `Approve all (${approvableCount})`}
        </button>
      </div>

      <div className="mt-3 max-h-96 space-y-3 overflow-y-auto pr-0.5">
        {groups.map((g) => {
          const groupKey = `group:${g.supplier ?? ""}`;
          const groupBusy = busy === groupKey;
          return (
            <div key={groupKey}>
              <div className="flex items-center justify-between gap-3 px-0.5 pb-1">
                <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  {g.supplier ?? "No supplier linked"}
                  <span className="ml-2 font-normal normal-case tracking-normal text-zinc-400">
                    {g.rows.length} style{g.rows.length === 1 ? "" : "s"} · {g.readyOutputs}{" "}
                    output{g.readyOutputs === 1 ? "" : "s"} ready
                  </span>
                </p>
                {g.approvableIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void approve(g.approvableIds, groupKey)}
                    disabled={busy != null}
                    title={`Approve the ${g.approvableIds.length} style(s) awaiting approval for this supplier`}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {groupBusy && <Spinner />}
                    {groupBusy ? "Approving…" : `Approve ${g.approvableIds.length}`}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-md border border-zinc-200 bg-white">
                {g.rows.map((s) => {
                  const rowBusy = busy === s.id;
                  return (
                    <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <Link
                          href={`/styles/${s.id}/review`}
                          className="truncate text-xs font-medium text-zinc-800 hover:underline"
                        >
                          {s.name}
                        </Link>
                        <p className="mt-0.5 text-[11px] text-zinc-500">
                          {s.poNumber ? `PO ${s.poNumber}` : "No PO"}
                          {countsLine(s)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span
                          className={
                            s.toApprove > 0
                              ? "text-xs font-semibold text-amber-600"
                              : "text-xs text-zinc-400"
                          }
                        >
                          {s.toApprove} ready
                        </span>
                        <button
                          type="button"
                          onClick={() => void approve([s.id], s.id)}
                          disabled={busy != null || !s.approvable}
                          title={
                            s.approvable
                              ? "Approve & publish this style"
                              : s.toApprove > 0
                                ? "Latest run isn't awaiting review — decide these outputs from the review page"
                                : "Nothing awaiting approval"
                          }
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {rowBusy && <Spinner />}
                          {rowBusy ? "Approving…" : "Approve"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {totalCount > styles.length && (
        <p className="mt-2 text-[11px] text-zinc-400">
          Showing the {styles.length} most recently updated of {totalCount} styles.
        </p>
      )}

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

// The muted per-style breakdown after the PO — only non-zero buckets, so quiet
// rows stay quiet ("PO 12345 · 3 approved" instead of five zeros).
function countsLine(s: ApprovalPanelStyle): string {
  const parts: string[] = [];
  if (s.approved > 0) parts.push(`${s.approved} approved`);
  if (s.coming > 0) parts.push(`${s.coming} coming`);
  if (s.blocked > 0) parts.push(`${s.blocked} blocked`);
  if (s.rejected > 0) parts.push(`${s.rejected} rejected`);
  if (s.excluded > 0) parts.push(`${s.excluded} excluded`);
  const line = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return `${line} · ${s.total} declared`;
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

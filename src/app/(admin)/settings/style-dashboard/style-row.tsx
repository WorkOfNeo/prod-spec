"use client";

import { useState } from "react";
import Link from "next/link";
import type { OutputState } from "@/lib/outputs/current-outputs";
import type { StyleDashboardRow, StyleOutputDetailRow } from "@/lib/dashboard/style-dashboard";

const STATE_CHIP: Record<OutputState, { cls: string; label: string }> = {
  APPROVED: { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "approved" },
  REJECTED: { cls: "border-red-200 bg-red-50 text-red-700", label: "rejected" },
  BLOCKED: { cls: "border-amber-200 bg-amber-50 text-amber-800", label: "blocked" },
  TO_REVIEW: { cls: "border-blue-200 bg-blue-50 text-blue-700", label: "to review" },
  GENERATING: { cls: "border-zinc-200 bg-zinc-50 text-zinc-500", label: "generating…" },
  READY_TO_GENERATE: { cls: "border-zinc-200 bg-zinc-50 text-zinc-500", label: "queued" },
  AWAITING_DATA: { cls: "border-amber-200 bg-amber-50 text-amber-800", label: "missing fields" },
  EXCLUDED: { cls: "border-zinc-200 bg-zinc-50 text-zinc-500", label: "excluded" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RollupChips({ row }: { row: StyleDashboardRow }) {
  const r = row.rollup;
  const chips: { n: number; cls: string; label: string }[] = [
    { n: r.generating, cls: "text-zinc-500", label: "generating" },
    { n: r.toReview, cls: "text-blue-700", label: "to review" },
    { n: r.blocked, cls: "text-amber-700", label: "blocked" },
    { n: r.rejected, cls: "text-red-700", label: "rejected" },
    { n: r.approved, cls: "text-emerald-700", label: "approved" },
  ];
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
      {chips
        .filter((c) => c.n > 0)
        .map((c) => (
          <span key={c.label} className={c.cls}>
            {c.n} {c.label}
          </span>
        ))}
      <span className="text-zinc-400">·</span>
      <span className="text-emerald-700">
        {r.uploadedSlots}/{r.generatedSlots} uploaded
      </span>
      <span className="text-emerald-700">
        {r.sentSlots}/{r.generatedSlots} sent
      </span>
    </span>
  );
}

function UploadedPill({ o }: { o: StyleOutputDetailRow }) {
  if (o.uploaded) {
    return (
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
        uploaded
      </span>
    );
  }
  const s = o.sharePointStatus;
  const failed = s === "FAILED" || s === "AMBIGUOUS" || s === "NO_FOLDER";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
        failed ? "border-red-200 bg-red-50 text-red-700" : "border-zinc-200 bg-zinc-50 text-zinc-500"
      }`}
      title={o.sharePointStatus ?? "not uploaded"}
    >
      {s ? s.toLowerCase() : "not uploaded"}
    </span>
  );
}

function EmailPill({ o }: { o: StyleOutputDetailRow }) {
  return o.emailed ? (
    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
      sent
    </span>
  ) : (
    <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
      not sent
    </span>
  );
}

export function StyleRow({ row }: { row: StyleDashboardRow }) {
  const [outputs, setOutputs] = useState<StyleOutputDetailRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadIfNeeded(open: boolean) {
    if (!open || outputs != null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/style-dashboard/style/${row.styleId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { outputs: StyleOutputDetailRow[] };
      setOutputs(data.outputs);
    } catch {
      setError("Couldn’t load outputs — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="group rounded-lg border border-zinc-200 bg-white"
      onToggle={(e) => loadIfNeeded((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium text-zinc-900">{row.name}</span>
            {row.businessArea && <span className="text-xs text-zinc-500">{row.businessArea}</span>}
            {row.hasInflight && (
              <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                generating
              </span>
            )}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {row.customer ?? "—"}
            {row.poNumber ? ` · PO ${row.poNumber}` : ""}
            {row.supplier ? ` · ${row.supplier}` : ""}
          </div>
        </div>
        <div className="hidden shrink-0 sm:block">
          <RollupChips row={row} />
        </div>
      </summary>

      <div className="border-t border-zinc-100 px-3 py-2">
        {/* Rollup is always shown on small screens where the summary hides it. */}
        <div className="mb-2 sm:hidden">
          <RollupChips row={row} />
        </div>

        {loading && <p className="py-3 text-xs text-zinc-500">Loading outputs…</p>}
        {error && <p className="py-3 text-xs text-red-600">{error}</p>}
        {outputs != null && outputs.length === 0 && (
          <p className="py-3 text-xs text-zinc-500">No outputs.</p>
        )}
        {outputs != null && outputs.length > 0 && (
          <ul className="divide-y divide-zinc-100">
            {outputs.map((o) => {
              const chip = STATE_CHIP[o.state];
              return (
                <li key={o.variantKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-zinc-700" title={o.fileName ?? undefined}>
                    {o.name}
                  </span>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chip.cls}`}>
                    {chip.label}
                  </span>
                  <span className="shrink-0">
                    <UploadedPill o={o} />
                  </span>
                  <span className="shrink-0">
                    <EmailPill o={o} />
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {o.sharePointUrl ? (
                      <a
                        href={o.sharePointUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-700 hover:underline"
                      >
                        File
                      </a>
                    ) : null}
                    {o.sharePointFolderUrl ? (
                      <a
                        href={o.sharePointFolderUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-700 hover:underline"
                      >
                        Folder
                      </a>
                    ) : null}
                    {!o.sharePointUrl && !o.sharePointFolderUrl && (
                      <span className="text-zinc-300" aria-hidden="true">
                        —
                      </span>
                    )}
                  </span>
                  <span className="w-28 shrink-0 text-right tabular-nums text-zinc-400">
                    {fmtDate(o.generatedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-2 flex gap-3 text-xs">
          <Link href={`/styles/${row.styleId}`} className="text-blue-700 hover:underline">
            Open style →
          </Link>
          <Link href={`/styles/${row.styleId}/review`} className="text-blue-700 hover:underline">
            Review →
          </Link>
        </div>
      </div>
    </details>
  );
}

"use client";

import { useMemo, useState } from "react";
import { CircleCheck, LoaderCircle, RotateCcw, Truck } from "lucide-react";
import type { ImpactRow } from "@/lib/change-requests/types";
import type { OutputView } from "@/lib/change-requests/review-view";
import { RowsTable } from "./impact-table";
import { errorOf, plural, sendJson } from "./shared";

// An output whose change is live (ADMIN): the published version, what the
// approval reran, and the approved documents that changed — which were NOT
// rerun (design §2, rail 3). Sending them back to review is the explicit
// second confirmation: pick styles, confirm, POST …/rerun-approved. They are
// regenerated with the new layout and need approving again before anything
// reaches a supplier.

export function PublishedPanel({ output, onChanged }: { output: OutputView; onChanged: () => void }) {
  const info = output.published;
  const impactRows = output.impact?.rows;
  const approvedChanged = useMemo(
    () => (impactRows ?? []).filter((r) => r.changed && r.reviewStatus === "APPROVED"),
    [impactRows],
  );
  const delivered = useMemo(() => (impactRows ?? []).filter((r) => r.changed && (r.uploaded || r.emailed)), [impactRows]);
  const sentBack = useMemo(() => new Set(info?.sentBackStyleIds ?? []), [info?.sentBackStyleIds]);

  const styles = useMemo(() => {
    const byStyle = new Map<string, ImpactRow[]>();
    for (const r of approvedChanged) byStyle.set(r.styleId, [...(byStyle.get(r.styleId) ?? []), r]);
    return [...byStyle.entries()].map(([styleId, rows]) => ({ styleId, label: rows[0].styleLabel, rows }));
  }, [approvedChanged]);

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(styles.map((s) => s.styleId).filter((id) => !sentBack.has(id))),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const pickedDocs = styles.filter((s) => picked.has(s.styleId)).reduce((n, s) => n + s.rows.length, 0);

  const sendBack = async () => {
    setBusy(true);
    setError(null);
    const res = await sendJson<{ summary?: string; enqueued?: number }>(
      `/api/admin/change-request-outputs/${output.id}/rerun-approved`,
      "POST",
      { styleIds: [...picked] },
    );
    setBusy(false);
    if (!res.ok) return setError(errorOf(res.data));
    setConfirming(false);
    setDone(res.data.summary ?? "Sent back to review.");
    onChanged();
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-900">
          <CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden />
          Live{info?.publishedVersion != null ? ` as layout version ${info.publishedVersion}` : ""}
          {output.publishedLabel && <span className="font-normal text-zinc-500">· {output.publishedLabel}</span>}
          {output.firstTryApproved && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
              Approved on the first draft
            </span>
          )}
        </h2>
        {info ? (
          <p className="mt-2 text-sm text-zinc-700">{info.summary}</p>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">The layout change is live.</p>
        )}
      </section>

      {approvedChanged.length > 0 && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            Approved documents that changed · {approvedChanged.length.toLocaleString("en")}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            These were approved before the change and were not rerun. Send them back to review to regenerate them with the new
            layout; nothing reaches a supplier until someone approves them again.
          </p>
          <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {styles.map((s) => (
              <li key={s.styleId} className="px-3 py-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.has(s.styleId)}
                    onChange={() => toggle(s.styleId)}
                    disabled={busy}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  <span className="font-medium text-zinc-900">{s.label}</span>
                  <span className="text-xs text-zinc-500">
                    {s.rows[0].poNumber ?? ""} · {plural(s.rows.length, "document")}
                  </span>
                  {sentBack.has(s.styleId) && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">sent back already</span>
                  )}
                  {s.rows.some((r) => r.uploaded || r.emailed) && (
                    <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] text-orange-700 ring-1 ring-inset ring-orange-200">
                      delivered
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>

          {confirming ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <p>
                Send {plural(pickedDocs, "approved document")} on {plural(picked.size, "style")} back to review? Split outputs
                regenerate every document of the output for the style.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={sendBack}
                  disabled={busy || picked.size === 0}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
                  Send back to review
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-white disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
                setDone(null);
              }}
              disabled={picked.size === 0}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Send approved documents back to review…
            </button>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          {done && <p className="mt-2 text-xs text-emerald-700">{done}</p>}
        </section>
      )}

      {delivered.length > 0 && (
        <section className="rounded-lg border border-orange-200 bg-white p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Truck className="h-4 w-4 text-orange-600" aria-hidden />
            Changed documents already delivered to the supplier · {delivered.length.toLocaleString("en")}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">The supplier has the old version of these.</p>
          <div className="mt-2 rounded-md border border-zinc-200">
            <RowsTable rows={delivered} />
          </div>
        </section>
      )}
    </div>
  );
}

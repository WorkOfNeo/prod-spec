"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PoDeliveryReport, DeliveryNameGroup } from "@/lib/sharepoint/po-delivery";

// =====================================================
// The per-PO delivery ledger, live.
//
// The list at /delivery reads stored snapshots so it can render hundreds of
// rows; this panel ALWAYS re-checks against SharePoint, because it is the
// surface a repair is launched from and repairing against a stale picture is
// how you delete a file that someone else just uploaded.
//
// Two outcomes are presented very differently on purpose:
//   • missing / under an old name → a transfer problem. One button fixes it:
//     the approved bytes are in the database, so they get re-pushed under the
//     name the layout asks for today.
//   • a file name two documents both want → a NAMING problem. There is no
//     button, because the folder can hold one file under one name and pushing
//     again would just overwrite the other document. The panel says exactly
//     what differs between them, which is the token the template is missing.
// =====================================================

type ApplyResponse = { ok?: boolean; error?: string; notes?: string[]; pushed?: number; staleDeleted?: number; restamped?: number };

async function fetchReport(supplierId: string, poNumber: string, signal?: AbortSignal): Promise<PoDeliveryReport> {
  const res = await fetch(
    `/api/admin/po-delivery?supplier=${encodeURIComponent(supplierId)}&po=${encodeURIComponent(poNumber)}`,
    { signal },
  );
  const body = (await res.json().catch(() => ({}))) as PoDeliveryReport & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function PoDeliveryPanel({ poNumber, supplierId }: { poNumber: string; supplierId: string }) {
  const [data, setData] = useState<PoDeliveryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchReport(supplierId, poNumber, ctrl.signal)
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setError(e.message || "Check failed");
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [supplierId, poNumber]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchReport(supplierId, poNumber));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check failed");
    } finally {
      setLoading(false);
    }
  }, [supplierId, poNumber]);

  async function repair() {
    setBusy(true);
    setNotes([]);
    setError(null);
    try {
      const res = await fetch("/api/admin/po-delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId, poNumber }),
      });
      const json = (await res.json().catch(() => ({}))) as ApplyResponse;
      if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
      setNotes([
        `Re-pushed ${json.pushed ?? 0} document(s), renamed ${json.restamped ?? 0}, removed ${json.staleDeleted ?? 0} old file(s).`,
        ...(json.notes ?? []),
      ]);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Repair failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return <Box tone="mute">Reading the supplier&apos;s folder…</Box>;
  }
  // A failed check is NOT an empty ledger. Never let a Graph blip read as
  // "nothing was delivered".
  if (error && !data) {
    return (
      <Box tone="warn">
        ⚠ Couldn&apos;t check the folder — {error}. Nothing is reported as missing: a failed lookup is not
        evidence that a file is gone.
      </Box>
    );
  }
  if (!data) return null;

  const listable = data.state === "ok" || data.state === "subfolder-missing";
  if (!listable) return <Box tone="warn">⚠ {data.message}</Box>;

  const t = data.totals;
  const repairable = data.names.filter((g) => g.wanted === 1 && !g.present).length;
  const collisions = data.names.filter((g) => g.wanted > 1);
  const outstanding = data.names.filter((g) => !g.present || g.wanted > 1);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="text-2xl font-semibold tabular-nums text-zinc-900">
            {t.deliveredDocs} of {t.expectedDocs}
          </span>
          <span className="ml-2 text-zinc-500">documents delivered</span>
          {data.folderUrl ? (
            <a
              href={data.folderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-3 text-xs underline text-zinc-500 hover:text-zinc-900"
            >
              Open folder ↗
            </a>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            {loading ? "Checking…" : "Re-check"}
          </button>
          {repairable > 0 ? (
            <button
              type="button"
              onClick={() => void repair()}
              disabled={busy || loading}
              title="Re-push the approved PDFs under the names their layouts ask for, then clear the old files"
              className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400"
            >
              {busy ? "Repairing…" : `Deliver the missing ${repairable}`}
            </button>
          ) : null}
        </div>
      </div>

      {/* Per style — the roll-up that makes a style with nothing delivered
          impossible to miss. */}
      <div className="overflow-hidden rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <tbody>
            {data.styles.map((s) => (
              <tr key={s.styleId} className="border-b border-zinc-100 last:border-0">
                <td className="px-4 py-2">
                  <Link href={`/styles/${s.styleId}`} className="underline hover:text-zinc-950">
                    {s.styleName}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <span className={s.delivered === s.expected ? "text-emerald-700" : s.delivered === 0 ? "font-semibold text-red-700" : "text-amber-700"}>
                    {s.delivered} of {s.expected}
                  </span>
                  {s.delivered === 0 ? <span className="ml-2 text-xs text-red-600">nothing delivered</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {notes.length > 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-4 py-3 text-xs text-emerald-900">
          {notes.map((n, i) => (
            <div key={i}>{i === 0 ? `✓ ${n}` : `• ${n}`}</div>
          ))}
        </div>
      ) : null}
      {error && data ? <Box tone="warn">{error}</Box> : null}

      {/* Collisions first: no button can fix these, and they are the ones that
          silently destroy artwork. */}
      {collisions.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-red-800">
            {t.collisionDocs} document(s) can never land — two outputs want one file name
          </h2>
          <p className="mt-1 text-xs text-zinc-600">
            A folder holds one file per name, so the second upload overwrites the first. Re-pushing cannot
            fix this; the layout&apos;s file name has to tell them apart. What differs is listed under each.
          </p>
          <ul className="mt-2 space-y-2">
            {collisions.map((g) => (
              <li key={g.fileName} className="rounded-lg border border-red-200 bg-red-50/40 px-3 py-2 text-xs">
                <div className="font-medium text-zinc-900">
                  {g.wanted}× <span className="break-all">{g.fileName}</span>
                  {g.present ? (
                    <span className="ml-2 font-normal text-zinc-500">— one is in the folder, the rest were overwritten</span>
                  ) : (
                    <span className="ml-2 font-normal text-zinc-500">— none delivered</span>
                  )}
                </div>
                <div className="mt-0.5 text-red-800">↳ {g.distinguishers.join(" · ")}</div>
                <div className="mt-1 space-y-0.5 text-zinc-500">
                  {g.documents.map((d) => (
                    <div key={d.jobAssetId}>
                      {d.styleName} · {d.name} · {d.variantKey.split("#")[1] ?? "whole style"}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold text-zinc-800">
          {outstanding.length === 0 ? "Every document is in the folder" : `${outstanding.length} file name(s) outstanding`}
        </h2>
        {outstanding.length === 0 ? (
          <p className="mt-1 text-xs text-emerald-700">
            ✓ Every approved document for this PO is in the supplier&apos;s folder under the name its layout
            asks for.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200">
            {outstanding.filter((g) => g.wanted === 1).map((g) => (
              <NameRow key={g.fileName} group={g} />
            ))}
          </ul>
        )}
      </section>

      {data.staleFiles.length > 0 || data.strayFiles.length > 0 ? (
        <section className="text-xs">
          <h2 className="text-sm font-semibold text-zinc-800">Other files in the folder</h2>
          {data.staleFiles.length > 0 ? (
            <p className="mt-1 text-zinc-600">
              <span className="font-medium">{data.staleFiles.length} left over from a rename</span> — ours,
              and cleared automatically when the repair runs: {data.staleFiles.map((f) => f.fileName).join(", ")}
            </p>
          ) : null}
          {data.strayFiles.length > 0 ? (
            <p className="mt-1 text-zinc-600">
              <span className="font-medium">{data.strayFiles.length} nothing on this PO accounts for</span> —
              usually the supplier&apos;s or customer&apos;s own upload, so they are never touched:{" "}
              {data.strayFiles.map((f) => f.fileName).join(", ")}
            </p>
          ) : null}
        </section>
      ) : null}

      <p className="text-[11px] text-zinc-400">Checked {new Date(data.checkedAt).toLocaleString()}.</p>
    </div>
  );
}

function NameRow({ group }: { group: DeliveryNameGroup }) {
  const d = group.documents[0];
  const renamed = group.presentAsPrevious;
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-xs">
      <span aria-hidden className={`mt-px shrink-0 font-semibold ${renamed ? "text-sky-600" : "text-red-600"}`}>
        {renamed ? "⟳" : "✗"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-zinc-500">{renamed ? "under an old name" : "missing"}</span>{" "}
        <span className="break-all text-zinc-800">{group.fileName}</span>
        <span className="block text-[11px] text-zinc-500">
          {d.styleName} · {d.name}
          {renamed ? ` · in the folder as “${d.previousFileName}”` : ""}
        </span>
      </span>
    </li>
  );
}

function Box({ tone, children }: { tone: "mute" | "warn"; children: React.ReactNode }) {
  const cls =
    tone === "warn" ? "border-amber-200 bg-amber-50/60 text-amber-800" : "border-zinc-200 bg-zinc-50 text-zinc-500";
  return <div className={`rounded-lg border px-4 py-2.5 text-xs ${cls}`}>{children}</div>;
}

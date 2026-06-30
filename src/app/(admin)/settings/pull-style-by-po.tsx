"use client";

import { useState } from "react";
import Link from "next/link";

// "Pull style by PO" — type a Contrast PO (e.g. C-62498), look up the matching
// style(s) on the Monday Pre-Order board + our DB, then pull the chosen ones
// onto the styleboard for layout testing. Pulled styles are pinned
// (Style.pulledForTestAt) so they show on /styles regardless of their Monday
// group; output generation is run from /styles afterwards.

type Candidate = {
  mondayItemId: string;
  name: string;
  poNumber: string | null;
  businessArea: string | null;
  customerName: string | null;
  groupTitle: string | null;
  inDb: boolean;
  styleId: string | null;
  alreadyPulled: boolean;
};

type PullResult = {
  pulled: Array<{ styleId: string; name: string }>;
  skipped: Array<{ mondayItemId: string; reason: string }>;
  errors: Array<{ mondayItemId: string; error: string }>;
};

type Pulled = { id: string; name: string; poNumber: string | null; customerName: string };

export function PullStyleByPo({ initialPulled }: { initialPulled: Pulled[] }) {
  const [po, setPo] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [pulling, setPulling] = useState(false);
  const [result, setResult] = useState<PullResult | null>(null);

  const [pulled, setPulled] = useState<Pulled[]>(initialPulled);
  const [unpulling, setUnpulling] = useState<string | null>(null);

  async function lookup() {
    if (!po.trim()) return;
    setLooking(true);
    setLookupError(null);
    setResult(null);
    setCandidates(null);
    setSelected(new Set());
    try {
      const res = await fetch("/api/admin/styles/pull-by-po/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ po: po.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as { candidates?: Candidate[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `Lookup failed (${res.status})`);
      const list = j.candidates ?? [];
      setCandidates(list);
      // Pre-select everything not already pulled.
      setSelected(new Set(list.filter((c) => !c.alreadyPulled).map((c) => c.mondayItemId)));
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLooking(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function refreshPulled() {
    const res = await fetch("/api/admin/styles/pull-by-po");
    const j = (await res.json().catch(() => ({}))) as { pulled?: Pulled[] };
    if (res.ok && j.pulled) setPulled(j.pulled);
  }

  async function pull() {
    if (selected.size === 0) return;
    setPulling(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/styles/pull-by-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mondayItemIds: [...selected] }),
      });
      const j = (await res.json().catch(() => ({}))) as PullResult & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `Pull failed (${res.status})`);
      setResult(j);
      setCandidates(null);
      setSelected(new Set());
      await refreshPulled();
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setPulling(false);
    }
  }

  async function unpull(styleId: string) {
    setUnpulling(styleId);
    try {
      const res = await fetch("/api/admin/styles/pull-by-po", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleId }),
      });
      if (res.ok) setPulled((prev) => prev.filter((p) => p.id !== styleId));
    } finally {
      setUnpulling(null);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-900">Pull style by PO</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Pull styles into the styleboard by Contrast PO number (e.g.{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">C-62498</code>) — paste a single PO
        or a comma/space-separated list to look up many at once. Useful for testing every output
        layout. Pulled styles stay visible on{" "}
        <Link href="/styles" className="underline hover:text-zinc-700">
          /styles
        </Link>{" "}
        even when their Monday group would normally hide them. Generate outputs from there.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          type="text"
          value={po}
          onChange={(e) => setPo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") lookup();
          }}
          placeholder="C-62498, C-62499, 62500…"
          className="w-96 rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={lookup}
          disabled={looking || !po.trim()}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {looking ? "Looking up…" : "Look up"}
        </button>
      </div>

      {lookupError ? <p className="mt-2 text-xs text-red-600">{lookupError}</p> : null}

      {candidates !== null ? (
        candidates.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No styles found for that PO.</p>
        ) : (
          <div className="mt-4">
            <div className="overflow-hidden rounded-md border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-3 py-2">Style</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Business area</th>
                    <th className="px-3 py-2">Group</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.mondayItemId} className="border-t border-zinc-100">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(c.mondayItemId)}
                          disabled={c.alreadyPulled}
                          onChange={() => toggle(c.mondayItemId)}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-zinc-900">
                        {c.name}
                        {c.poNumber ? (
                          <span className="ml-1 text-xs font-normal text-zinc-400">{c.poNumber}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-zinc-600">{c.customerName ?? "—"}</td>
                      <td className="px-3 py-2 text-zinc-600">{c.businessArea ?? "—"}</td>
                      <td className="px-3 py-2 text-zinc-500">{c.groupTitle ?? "—"}</td>
                      <td className="px-3 py-2">
                        {c.alreadyPulled ? (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
                            Pulled
                          </span>
                        ) : c.inDb ? (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                            In DB
                          </span>
                        ) : (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                            New
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={pull}
                disabled={pulling || selected.size === 0}
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {pulling ? "Pulling…" : `Pull ${selected.size} into styleboard`}
              </button>
              <span className="text-xs text-zinc-400">
                Refreshes each from Monday, then pins it. Outputs are generated from /styles.
              </span>
            </div>
          </div>
        )
      ) : null}

      {result ? (
        <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <p className="font-medium text-zinc-900">
            Pulled {result.pulled.length} style{result.pulled.length === 1 ? "" : "s"}.{" "}
            {result.pulled.length > 0 ? (
              <Link href="/styles" className="underline hover:text-zinc-700">
                View on /styles
              </Link>
            ) : null}
          </p>
          {result.skipped.length > 0 ? (
            <div className="mt-2 text-xs text-amber-700">
              <p className="font-medium">Skipped {result.skipped.length} (need attention):</p>
              <ul className="ml-4 list-disc">
                {result.skipped.map((s) => (
                  <li key={s.mondayItemId}>{s.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.errors.length > 0 ? (
            <div className="mt-2 text-xs text-red-600">
              <p className="font-medium">Errored {result.errors.length}:</p>
              <ul className="ml-4 list-disc">
                {result.errors.map((e) => (
                  <li key={e.mondayItemId}>
                    {e.mondayItemId}: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {pulled.length > 0 ? (
        <div className="mt-5 border-t border-zinc-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Currently pulled ({pulled.length})
          </h3>
          <ul className="mt-2 divide-y divide-zinc-100">
            {pulled.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-zinc-700">
                  <Link href={`/styles/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  <span className="ml-2 text-xs text-zinc-400">
                    {p.customerName}
                    {p.poNumber ? ` · ${p.poNumber}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => unpull(p.id)}
                  disabled={unpulling === p.id}
                  className="text-xs text-zinc-500 underline hover:text-red-600 disabled:opacity-50"
                >
                  {unpulling === p.id ? "Removing…" : "Un-pull"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

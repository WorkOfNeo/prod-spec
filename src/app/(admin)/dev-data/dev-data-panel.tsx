"use client";

import { useCallback, useEffect, useState } from "react";
import type { LoadedPo, RecentPo, SyncSummary } from "@/lib/dev-data/sync";

// The /dev-data page: loaded POs (with their sync state) on top, production's
// most recent POs below to pick from. Everything goes through /api/admin/dev-data.

type Data = { recent: RecentPo[]; pos: LoadedPo[]; referenceSyncedAt: string | null };

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function describe(s: SyncSummary): string {
  if (s.busy) return "A sync is already running — try again in a moment.";
  const copied = s.tables.reduce((n, t) => n + t.copied, 0);
  const deleted = s.tables.reduce((n, t) => n + t.deleted, 0);
  const what = `${copied} row${copied === 1 ? "" : "s"} copied, ${deleted} deleted`;
  return s.ok ? `Done: ${what}.` : `Finished with errors (${what}): ${s.error}`;
}

export function DevDataPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (q: string) => {
    const res = await fetch(`/api/admin/dev-data?search=${encodeURIComponent(q)}`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) {
      setLoadError(body.error ?? `Request failed (${res.status})`);
      return;
    }
    setLoadError(null);
    setData(body);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, refresh]);

  async function act(label: string, payload: object) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/dev-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if ("tables" in body) setMessage({ ok: Boolean(body.ok), text: describe(body as SyncSummary) });
      else if (!res.ok || body.ok === false) setMessage({ ok: false, text: body.error ?? `Request failed (${res.status})` });
      await refresh(search);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  function toggle(po: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(po)) next.delete(po);
      else next.add(po);
      return next;
    });
  }

  if (loadError) {
    return <div className="mt-6 rounded-lg border border-transparent bg-bad-soft p-4 text-sm text-bad">{loadError}</div>;
  }
  if (!data) return <div className="mt-6 text-sm text-muted">Loading…</div>;

  const pickable = data.recent.filter((p) => !p.loaded);

  return (
    <div className="mt-6 flex flex-col gap-8">
      {message ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            message.ok ? "border-transparent bg-good-soft text-good" : "border-transparent bg-bad-soft text-bad"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <section>
        <div className="mb-2 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Loaded here ({data.pos.length})</h2>
            <p className="text-xs text-muted">Reference data (users, customers, prod specs, layouts, settings) last synced {when(data.referenceSyncedAt)}.</p>
          </div>
          <button
            type="button"
            disabled={busy !== null || data.pos.length === 0}
            onClick={() => act("sync", { action: "sync" })}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "sync" ? "Syncing…" : "Sync now"}
          </button>
        </div>
        {data.pos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface p-6 text-center text-sm text-muted">
            Nothing loaded yet. Pick POs below.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">PO</th>
                  <th className="px-4 py-2 font-medium">Styles</th>
                  <th className="px-4 py-2 font-medium">Loaded</th>
                  <th className="px-4 py-2 font-medium">Last synced</th>
                  <th className="px-4 py-2 font-medium">Keep in sync</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.pos.map((p) => (
                  <tr key={p.poNumber} className="border-t border-line align-top">
                    <td className="px-4 py-2 font-mono text-xs">{p.poNumber}</td>
                    <td className="px-4 py-2 tabular-nums">{p.styleCount}</td>
                    <td className="px-4 py-2 text-muted">{when(p.loadedAt)}</td>
                    <td className="px-4 py-2 text-muted">
                      {when(p.lastSyncedAt)}
                      {p.lastError ? <div className="mt-1 text-xs text-bad">{p.lastError}</div> : null}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={p.syncEnabled}
                        disabled={busy !== null}
                        aria-label={`Keep ${p.poNumber} in sync`}
                        onChange={(e) => act("toggle", { action: "toggle", po: p.poNumber, enabled: e.target.checked })}
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (confirm(`Remove PO ${p.poNumber} from this environment? Its styles and everything made on them here are deleted. Production is not touched.`)) {
                            void act("remove", { action: "remove", po: p.poNumber });
                          }
                        }}
                        className="text-xs text-muted underline hover:text-bad disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Recent POs in production</h2>
            <p className="text-xs text-muted">Newest first, by when their latest style came in.</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a PO number"
              aria-label="Find a PO number"
              className="w-56 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              disabled={busy !== null || selected.size === 0}
              onClick={() => act("load", { action: "load", pos: [...selected] }).then(() => setSelected(new Set()))}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "load" ? "Loading…" : `Load selected${selected.size ? ` (${selected.size})` : ""}`}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs text-muted">
              <tr>
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select every PO shown"
                    checked={pickable.length > 0 && pickable.every((p) => selected.has(p.poNumber))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(pickable.map((p) => p.poNumber)) : new Set())}
                  />
                </th>
                <th className="px-4 py-2 font-medium">PO</th>
                <th className="px-4 py-2 font-medium">Styles</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Supplier</th>
                <th className="px-4 py-2 font-medium">Came in</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted">
                    No PO matches.
                  </td>
                </tr>
              ) : (
                data.recent.map((p) => (
                  <tr
                    key={p.poNumber}
                    className={`border-t border-line ${p.loaded ? "text-faint" : "cursor-pointer hover:bg-subtle"}`}
                    onClick={() => !p.loaded && toggle(p.poNumber)}
                  >
                    <td className="px-4 py-2">
                      {p.loaded ? (
                        <span className="rounded-full bg-good-soft px-2 py-0.5 text-[11px] font-medium text-good">Loaded</span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.poNumber}`}
                          checked={selected.has(p.poNumber)}
                          onChange={() => toggle(p.poNumber)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{p.poNumber}</td>
                    <td className="px-4 py-2 tabular-nums">{p.styleCount}</td>
                    <td className="px-4 py-2">{p.customers.join(", ")}</td>
                    <td className="px-4 py-2 text-muted">{p.suppliers.join(", ") || "—"}</td>
                    <td className="px-4 py-2 text-muted">{when(p.lastSeenAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

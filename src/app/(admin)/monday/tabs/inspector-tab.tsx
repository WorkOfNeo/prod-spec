"use client";

import { useEffect, useState } from "react";

type KnownBoard = { id: string; label: string };

type InspectorPayload = {
  board: { id: string; name: string; description: string | null };
  columns: Array<{
    id: string;
    title: string;
    type: string;
    description: string | null;
    settings: unknown;
  }>;
  sample: {
    id: string;
    name: string;
    columns: Array<{ id: string; type: string; text: string | null; value: unknown }>;
  } | null;
};

// Migrated from /monday-inspect — same behaviour, lives inside /monday's
// Inspector tab. We keep the URL behaviour of writing `boardId` back to
// the query string so refreshes hold their pick; the tab key is preserved
// because we never touch the `tab=` param.
export function InspectorTab({
  knownBoards,
  initialBoardId,
}: {
  knownBoards: KnownBoard[];
  initialBoardId: string | null;
}) {
  const [boardId, setBoardId] = useState(initialBoardId ?? "");
  const [data, setData] = useState<InspectorPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(id: string) {
    if (!id) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/admin/monday/columns?boardId=${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(body as InspectorPayload);
      // Reflect the chosen board in the URL so it's shareable / refreshable.
      // Preserve any other params (tab, dataset, ...).
      const url = new URL(window.location.href);
      url.searchParams.set("boardId", id);
      window.history.replaceState({}, "", url.toString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!initialBoardId) return;
    // Defer the fetch so we're not calling setState synchronously inside
    // the effect — keeps React 19's `set-state-in-effect` lint happy and
    // lets the initial paint complete before the load spinner appears.
    const id = setTimeout(() => void load(initialBoardId), 0);
    return () => clearTimeout(id);
    // Intentionally only on mount — `load` doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void load(boardId.trim());
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-3 rounded-xl border border-line bg-surface p-4"
      >
        <label className="flex-1 text-xs font-medium text-ink">
          Board ID
          <input
            type="text"
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
            placeholder="6979419195"
            className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-sm"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink">Known boards</span>
          <div className="flex flex-wrap gap-2">
            {knownBoards.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setBoardId(b.id);
                  void load(b.id);
                }}
                className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-subtle"
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="submit"
          disabled={loading || !boardId.trim()}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Loading…" : "Inspect"}
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-transparent bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </div>
      )}

      {data && (
        <>
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">Board</h2>
            <p className="mt-1 text-sm">
              <span className="font-medium">{data.board.name}</span>{" "}
              <span className="font-mono text-xs text-muted">{data.board.id}</span>
            </p>
            {data.board.description && (
              <p className="mt-1 text-xs text-muted">{data.board.description}</p>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <header className="border-b border-line bg-subtle px-4 py-2 text-xs font-medium text-muted">
              Columns ({data.columns.length})
            </header>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2">ID</th>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Settings</th>
                </tr>
              </thead>
              <tbody>
                {data.columns.map((c) => (
                  <tr key={c.id} className="border-t border-line align-top">
                    <td className="px-4 py-2 font-mono text-xs">
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(c.id)}
                        title="Copy column id"
                        className="text-ink underline"
                      >
                        {c.id}
                      </button>
                    </td>
                    <td className="px-4 py-2">{c.title}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted">{c.type}</td>
                    <td className="px-4 py-2 text-xs">
                      {c.settings != null && Object.keys(c.settings as object).length > 0 ? (
                        <details>
                          <summary className="cursor-pointer text-muted">view</summary>
                          <pre className="mt-1 max-w-md overflow-x-auto rounded bg-subtle p-2 font-mono text-[11px] leading-tight">
                            {JSON.stringify(c.settings, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {data.sample && (
            <section className="overflow-hidden rounded-xl border border-line bg-surface">
              <header className="border-b border-line bg-subtle px-4 py-2 text-xs font-medium text-muted">
                Sample item — {data.sample.name}{" "}
                <span className="font-mono text-faint">({data.sample.id})</span>
              </header>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2">Column ID</th>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Text</th>
                    <th className="px-4 py-2">Raw value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sample.columns.map((cv) => (
                    <tr key={cv.id} className="border-t border-line align-top">
                      <td className="px-4 py-2 font-mono text-xs">{cv.id}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted">{cv.type}</td>
                      <td className="px-4 py-2 text-xs">
                        {cv.text ?? <span className="text-faint">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {cv.value != null ? (
                          <details>
                            <summary className="cursor-pointer text-muted">view</summary>
                            <pre className="mt-1 max-w-md overflow-x-auto rounded bg-subtle p-2 font-mono text-[11px] leading-tight">
                              {JSON.stringify(cv.value, null, 2)}
                            </pre>
                          </details>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <header className="border-b border-line bg-subtle px-4 py-2 text-xs font-medium text-muted">
              Raw JSON
            </header>
            <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-tight text-ink">
              {JSON.stringify(data, null, 2)}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}

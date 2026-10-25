"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type TranslationRow = {
  id: string;
  key: string;
  sourceText: string;
  translations: Record<string, string>;
  category: string | null;
  active: boolean;
  lastSyncedAt: string | null;
};

type LanguageInfo = { code: string; name: string };

type Props = {
  rows: TranslationRow[];
  languages: LanguageInfo[];
};

export function TranslationList({ rows, languages }: Props) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<TranslationRow | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.sourceText.toLowerCase().includes(q)) return true;
      if (r.category?.toLowerCase().includes(q)) return true;
      for (const v of Object.values(r.translations)) {
        if (v.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [rows, query]);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search English or any translation…"
          className="w-80 rounded-md border border-line px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">
            {filtered.length} / {rows.length}
          </span>
          <SyncButton />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2">English (source)</th>
              <th className="px-4 py-2">Category</th>
              <th className="px-4 py-2">Languages</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted">
                  {rows.length === 0 ? (
                    <>
                      No translations yet. Click <strong>Sync from Monday</strong> to pull the
                      dictionary board into the database.
                    </>
                  ) : (
                    <>No phrase matches &ldquo;{query}&rdquo;.</>
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                // en is auto-seeded from the source; count only the real
                // translated languages for an honest coverage number.
                const langCount = Object.keys(r.translations).filter((c) => c !== "en").length;
                return (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-4 py-2 font-medium">{r.sourceText}</td>
                    <td className="px-4 py-2 text-xs text-muted">{r.category ?? "—"}</td>
                    <td className="px-4 py-2 text-xs text-muted">{langCount}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                          r.active ? "bg-good-soft text-good" : "bg-subtle text-muted"
                        }`}
                      >
                        {r.active ? "active" : "disabled"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setView(r)}
                        className="text-xs text-ink underline"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {view && (
        <ViewDialog row={view} languages={languages} onClose={() => setView(null)} />
      )}
    </>
  );
}

function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/translations/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMsg(`error: ${body.error ?? res.statusText}`);
        return;
      }
      const unmapped = Array.isArray(body.unmappedColumns) && body.unmappedColumns.length
        ? ` · unmapped: ${body.unmappedColumns.join(", ")}`
        : "";
      setMsg(`synced ${body.translationsUpserted} phrases, ${body.columnsMapped} languages${unmapped}`);
      router.refresh();
    } catch (err) {
      setMsg(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {msg && <span className="max-w-md truncate text-xs text-muted">{msg}</span>}
      <button
        type="button"
        onClick={sync}
        disabled={busy}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Sync from Monday"}
      </button>
    </div>
  );
}

function ViewDialog({
  row,
  languages,
  onClose,
}: {
  row: TranslationRow;
  languages: LanguageInfo[];
  onClose: () => void;
}) {
  const nameByCode = new Map(languages.map((l) => [l.code, l.name]));
  // Show seeded languages first (in nav order), then any orphan codes the
  // row carries that aren't (or no longer are) in the active set.
  const orderedCodes: string[] = [];
  const seen = new Set<string>();
  for (const l of languages) {
    if (row.translations[l.code] !== undefined) {
      orderedCodes.push(l.code);
      seen.add(l.code);
    }
  }
  for (const code of Object.keys(row.translations)) {
    if (!seen.has(code)) orderedCodes.push(code);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-[rgb(15_17_21/0.30)] p-6">
      <div className="my-12 w-full max-w-2xl rounded-lg bg-surface p-5 shadow-xl">
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold">{row.sourceText}</h2>
          <button onClick={onClose} className="text-xs text-muted underline">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-muted">
          {row.category ? `${row.category} · ` : ""}
          {orderedCodes.length} languages
          {row.lastSyncedAt
            ? ` · synced ${new Date(row.lastSyncedAt).toLocaleDateString()}`
            : ""}
        </p>

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {orderedCodes.map((code) => (
            <div key={code} className="rounded-md border border-line px-3 py-2">
              <div className="text-[11px] font-medium text-faint">
                {nameByCode.get(code) ?? code}{" "}
                <span className="font-mono normal-case">{code}</span>
              </div>
              <div className="text-sm text-ink">{row.translations[code] || "—"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

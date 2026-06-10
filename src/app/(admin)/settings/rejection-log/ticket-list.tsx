"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";

export type TicketRow = {
  id: string;
  status: "OPEN" | "IN_PROGRESS" | "FIXED" | "RESOLVED";
  styleId: string;
  styleName: string;
  styleNumber: string;
  outputName: string;
  variantKey: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  comment: string;
  reportedBy: string;
  reopenedCount: number;
  createdAtLabel: string;
  historyLabel: string;
  latest: {
    jobId: string;
    previewQuery: string;
    placeholderCount: number;
    reviewStatus: string;
    jobStatus: string;
    generatedAtLabel: string;
  } | null;
  searchBlob: string;
};

const STATUSES = ["OPEN", "IN_PROGRESS", "FIXED", "RESOLVED"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_PILLS: Record<Status, string> = {
  OPEN: "border-red-200 bg-red-50 text-red-700",
  IN_PROGRESS: "border-amber-200 bg-amber-50 text-amber-700",
  FIXED: "border-blue-200 bg-blue-50 text-blue-700",
  RESOLVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function TicketList({ rows }: { rows: TicketRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  // RESOLVED is hidden by default — the workbench shows actionable threads.
  const [enabled, setEnabled] = useState<Set<Status>>(new Set(["OPEN", "IN_PROGRESS", "FIXED"]));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);

  const counts = useMemo(() => {
    const c: Record<Status, number> = { OPEN: 0, IN_PROGRESS: 0, FIXED: 0, RESOLVED: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => enabled.has(r.status) && (q === "" || r.searchBlob.includes(q)));
  }, [rows, query, enabled]);

  function toggleStatus(s: Status) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function act(row: TicketRow, action: "start" | "rerun" | "fix") {
    setErrors((e) => ({ ...e, [row.id]: "" }));
    setNotes((n) => ({ ...n, [row.id]: "" }));
    setPending({ id: row.id, action });
    try {
      const res = await fetch(`/api/admin/rejection-tickets/${row.id}/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        email?: EmailOutcomeView | null;
        latestAsset?: { placeholderCount: number } | null;
      };
      if (!res.ok) {
        setErrors((e) => ({ ...e, [row.id]: body.error ?? `HTTP ${res.status}` }));
        return;
      }
      if (action === "rerun") {
        const ph = body.latestAsset?.placeholderCount ?? 0;
        setNotes((n) => ({
          ...n,
          [row.id]:
            ph > 0
              ? `Re-generated, but ${ph} placeholder(s) remain — the data gap isn't fixed yet.`
              : "Re-generated — check the fresh preview below.",
        }));
      }
      if (action === "fix" && body.email) setEmail(body.email);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search style, PO, output, comment…"
          className="w-64 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
        />
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleStatus(s)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              enabled.has(s) ? STATUS_PILLS[s] : "border-zinc-200 bg-white text-zinc-300"
            }`}
            title={enabled.has(s) ? `Hide ${s} tickets` : `Show ${s} tickets`}
          >
            {s.replace("_", " ")} · {counts[s]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400">
          {rows.length === 0
            ? "No rejections yet — when a reviewer rejects an output, its ticket lands here."
            : "Nothing matches the current filters."}
        </p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[11px] tracking-wide text-zinc-500 uppercase">
                <th className="px-3 py-2 font-semibold">Created</th>
                <th className="px-3 py-2 font-semibold">Style</th>
                <th className="px-3 py-2 font-semibold">Output</th>
                <th className="px-3 py-2 font-semibold">Customer · BA</th>
                <th className="px-3 py-2 font-semibold">PO</th>
                <th className="px-3 py-2 font-semibold">Comment</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  expanded={expanded === row.id}
                  onToggle={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
                  pendingAction={pending?.id === row.id ? pending.action : null}
                  error={errors[row.id] || null}
                  note={notes[row.id] || null}
                  onAct={(action) => act(row, action)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {email ? <EmailSimulationDialog outcome={email} onClose={() => setEmail(null)} /> : null}
    </div>
  );
}

function Row({
  row,
  expanded,
  onToggle,
  pendingAction,
  error,
  note,
  onAct,
}: {
  row: TicketRow;
  expanded: boolean;
  onToggle: () => void;
  pendingAction: string | null;
  error: string | null;
  note: string | null;
  onAct: (action: "start" | "rerun" | "fix") => void;
}) {
  const actionable = row.status === "OPEN" || row.status === "IN_PROGRESS";
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 ${expanded ? "bg-zinc-50" : ""}`}
      >
        <td className="px-3 py-2 whitespace-nowrap text-zinc-500">{row.createdAtLabel}</td>
        <td className="px-3 py-2">
          <div className="font-medium text-zinc-800">{row.styleName}</div>
          <div className="font-mono text-[10px] text-zinc-400">{row.styleNumber}</div>
        </td>
        <td className="px-3 py-2 text-zinc-600">{row.outputName}</td>
        <td className="px-3 py-2 text-zinc-600">
          {row.customerName}
          {row.businessArea ? ` · ${row.businessArea}` : ""}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-zinc-600">{row.poNumber ?? "—"}</td>
        <td className="max-w-56 truncate px-3 py-2 text-zinc-600" title={row.comment}>
          {row.comment}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${STATUS_PILLS[row.status]}`}
          >
            {row.status.replace("_", " ")}
            {row.reopenedCount > 0 ? ` ×${row.reopenedCount + 1}` : ""}
          </span>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-zinc-100 last:border-b-0">
          <td colSpan={7} className="bg-zinc-50 px-4 py-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">
                  Comment{row.reopenedCount > 0 ? " (incl. re-rejections)" : ""}
                </div>
                <p className="mt-1 text-xs whitespace-pre-wrap text-zinc-700">{row.comment}</p>
                <p className="mt-2 text-[11px] text-zinc-400">— {row.reportedBy}</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">Context</div>
                <p className="mt-1 text-xs text-zinc-700">
                  {row.customerName}
                  {row.businessArea ? ` · ${row.businessArea}` : ""}
                  {row.poNumber ? ` · PO ${row.poNumber}` : ""}
                </p>
                <p className="mt-1 font-mono text-[11px] break-all text-zinc-500">
                  {row.variantKey || `(no variant key — full re-run)`}
                </p>
                <div className="mt-2 flex gap-3 text-xs">
                  <Link href={`/styles/${row.styleId}`} className="text-zinc-500 underline hover:text-zinc-800">
                    Open style →
                  </Link>
                  <Link
                    href={`/styles/${row.styleId}/review`}
                    className="text-zinc-500 underline hover:text-zinc-800"
                  >
                    Review screen →
                  </Link>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">History</div>
                <p className="mt-1 text-xs text-zinc-700">{row.historyLabel}</p>
                {row.latest ? (
                  <p className="mt-2 text-xs text-zinc-500">
                    Latest run {row.latest.generatedAtLabel} · {row.latest.reviewStatus.toLowerCase().replace("_", " ")}
                    {row.latest.placeholderCount > 0 ? (
                      <span className="text-amber-700">
                        {" "}
                        · ⚠ {row.latest.placeholderCount} placeholder(s)
                      </span>
                    ) : (
                      <span className="text-emerald-700"> · no placeholders</span>
                    )}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-zinc-400">No generated asset for this output right now.</p>
                )}
              </div>
            </div>

            {row.latest ? (
              <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
                <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-1.5">
                  <span className="text-[11px] font-semibold text-zinc-500">
                    Latest PDF — generated {row.latest.generatedAtLabel}
                  </span>
                  <a
                    href={`/api/admin/jobs/${row.latest.jobId}/preview?${row.latest.previewQuery}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-500 underline"
                  >
                    Open
                  </a>
                </div>
                <iframe
                  src={`/api/admin/jobs/${row.latest.jobId}/preview?${row.latest.previewQuery}`}
                  className="block h-72 w-full bg-white"
                  title={`Latest ${row.outputName}`}
                />
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {row.status === "OPEN" ? (
                <button
                  type="button"
                  onClick={() => onAct("start")}
                  disabled={pendingAction !== null}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                >
                  {pendingAction === "start" ? "Starting…" : "Start work"}
                </button>
              ) : null}
              {actionable ? (
                <>
                  <button
                    type="button"
                    onClick={() => onAct("rerun")}
                    disabled={pendingAction !== null}
                    title="Regenerate this output WITHOUT notifying the reviewer"
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {pendingAction === "rerun" ? "Re-running…" : "↻ Re-run output (silent)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAct("fix")}
                    disabled={pendingAction !== null}
                    title="Final re-run + email the reviewer that it's ready for another look"
                    className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {pendingAction === "fix" ? "Fixing…" : "✓ Mark fixed & notify reviewer"}
                  </button>
                </>
              ) : null}
              {row.status === "FIXED" ? (
                <span className="text-xs text-blue-700">
                  Awaiting re-review — the reviewer was notified. Approval resolves this ticket; another
                  rejection reopens it.
                </span>
              ) : null}
              {row.status === "RESOLVED" ? (
                <span className="text-xs text-emerald-700">Resolved — the re-generated output was approved.</span>
              ) : null}
              {error ? <span className="text-xs text-red-600">{error}</span> : null}
              {note ? <span className="text-xs text-emerald-700">{note}</span> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

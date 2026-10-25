"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CheckAction, CheckRow, CheckSection } from "@/lib/checks/po-checks";
import type { PoChecksReport } from "@/lib/checks/run-po-checks";
import type { AppliedAction } from "@/lib/checks/apply-actions";

// =====================================================
// One UI shell, two checks.
//
// The shape is the same for both because the question is: every check shows the
// rows that DON'T look right first, with the app's proposed remedy already
// ticked, and then — not hidden behind a toggle by default, but there — every
// file that was scanned and is fine. The second group is the point of the page
// as much as the first: a reviewer needs to see the coverage to trust the
// finding, otherwise "0 problems" is indistinguishable from "nothing was
// looked at".
//
// A pre-selected action is a RECOMMENDATION, and the app declines to recommend
// what it cannot explain: a flagged row whose finding has no one-sentence
// justification arrives with nothing ticked (see po-checks.ts). Those rows read
// as "check this", not as "we are about to remove this".
//
// Nothing here decides what is safe. The confirm dialog names every affected
// file before anything happens, and the server re-runs the whole check and
// re-validates every row before it touches SharePoint — this component cannot
// talk it into acting on a row it did not itself flag.
// =====================================================

type HistoryRow = {
  id: string;
  action: string;
  fileName: string;
  newFileName: string | null;
  outcome: string;
  verdict: string | null;
  userEmail: string | null;
  createdAt: string;
};

type GetResponse = {
  report?: PoChecksReport;
  history?: HistoryRow[];
  needsSupplier?: Array<{ supplierId: string; supplierName: string | null }>;
  error?: string;
};

type ApplyResponse = {
  ok?: boolean;
  error?: string;
  applied?: AppliedAction[];
  done?: number;
  refused?: number;
  failed?: number;
  report?: PoChecksReport;
  history?: HistoryRow[];
};

// checkId + item id. The Graph item id is the file's identity everywhere in
// this feature — a name is ambiguous the moment somebody renames something.
const rowKey = (checkId: string, itemId: string) => `${checkId}:${itemId}`;

// Seed the selection from the app's proposals. Re-run on every fresh report:
// a scan is a new picture, and carrying ticks across it would let a user
// confirm a file the check no longer flags.
function seedSelection(report: PoChecksReport): Map<string, CheckAction> {
  const out = new Map<string, CheckAction>();
  for (const s of report.sections) {
    for (const r of s.flagged) {
      if (r.proposed) out.set(rowKey(s.id, r.id), r.proposed);
    }
  }
  return out;
}

export function ChecksPanel({ initialPo, initialSupplier }: { initialPo: string; initialSupplier: string | null }) {
  const router = useRouter();
  const [poInput, setPoInput] = useState(initialPo);
  const [po, setPo] = useState(initialPo);
  const [supplierId, setSupplierId] = useState<string | null>(initialSupplier);
  const [report, setReport] = useState<PoChecksReport | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [needsSupplier, setNeedsSupplier] = useState<GetResponse["needsSupplier"]>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Map<string, CheckAction>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AppliedAction[] | null>(null);
  // Per-row re-check notes, so a single row can report on itself without the
  // whole page reloading under the reviewer's cursor.
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({});
  const abort = useRef<AbortController | null>(null);

  const scan = useCallback(
    async (poNumber: string, supplier: string | null) => {
      if (!poNumber.trim()) return;
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setLoading(true);
      setError(null);
      setOutcome(null);
      setRowNotes({});
      try {
        const qs = new URLSearchParams({ po: poNumber });
        if (supplier) qs.set("supplier", supplier);
        const res = await fetch(`/api/admin/checks?${qs.toString()}`, { signal: ctrl.signal });
        const body = (await res.json().catch(() => ({}))) as GetResponse;
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (body.needsSupplier) {
          setNeedsSupplier(body.needsSupplier);
          setReport(null);
          return;
        }
        setNeedsSupplier(undefined);
        setHistory(body.history ?? []);
        if (body.report) {
          setReport(body.report);
          setSupplierId(body.report.supplierId);
          setSelection(seedSelection(body.report));
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "The check failed");
        setReport(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (po.trim()) void scan(po, supplierId);
    // supplierId is set by the scan itself; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po, scan]);

  function submitPo(e: React.FormEvent) {
    e.preventDefault();
    const next = poInput.trim();
    setSupplierId(null);
    setPo(next);
    // Keep the URL linkable so a finding can be shared with a colleague.
    router.replace(next ? `/checks?po=${encodeURIComponent(next)}` : "/checks");
  }

  const selected = useMemo(() => [...selection.entries()], [selection]);

  // The rows the confirm dialog will name, resolved back out of the report so
  // the dialog can only ever describe files the current scan actually flagged.
  const selectedRows = useMemo(() => {
    if (!report) return [];
    const out: Array<{ section: CheckSection; row: CheckRow; action: CheckAction }> = [];
    for (const section of report.sections) {
      for (const row of section.flagged) {
        const action = selection.get(rowKey(section.id, row.id));
        if (action) out.push({ section, row, action });
      }
    }
    return out;
  }, [report, selection]);

  function toggle(checkId: string, row: CheckRow, action: CheckAction | null) {
    setSelection((prev) => {
      const next = new Map(prev);
      const k = rowKey(checkId, row.id);
      if (action == null) next.delete(k);
      else next.set(k, action);
      return next;
    });
  }

  async function apply(rows: Array<{ section: CheckSection; row: CheckRow; action: CheckAction }>) {
    if (!report || !supplierId || rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          poNumber: report.poNumber,
          actions: rows.map(({ section, row, action }) => ({
            checkId: section.id,
            itemId: row.id,
            fileName: row.fileName,
            action,
            newName: action === "rename" ? row.renameTo : undefined,
          })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as ApplyResponse;
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      setOutcome(body.applied ?? []);
      setHistory(body.history ?? []);
      if (body.report) {
        setReport(body.report);
        setSelection(seedSelection(body.report));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The folder change failed");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  // Re-check ONE row. The folder listing is a single call either way, so this
  // re-runs the check and then updates only this row — which is the behaviour
  // that matters: the reviewer keeps their place and their other ticks.
  async function recheckRow(section: CheckSection, row: CheckRow) {
    if (!report || !supplierId) return;
    const k = rowKey(section.id, row.id);
    setRowNotes((p) => ({ ...p, [k]: "Re-checking…" }));
    try {
      const qs = new URLSearchParams({ po: report.poNumber, supplier: supplierId });
      const res = await fetch(`/api/admin/checks?${qs.toString()}`);
      const body = (await res.json().catch(() => ({}))) as GetResponse;
      if (!res.ok || !body.report) throw new Error(body.error ?? `HTTP ${res.status}`);
      const fresh = body.report.sections.find((s) => s.id === section.id);
      const flagged = fresh?.flagged.find((r) => r.id === row.id);
      const fine = fresh?.ok.find((r) => r.id === row.id);
      setReport((prev) => {
        if (!prev || !flagged) return prev;
        return {
          ...prev,
          sections: prev.sections.map((s) =>
            s.id === section.id ? { ...s, flagged: s.flagged.map((r) => (r.id === row.id ? flagged : r)) } : s,
          ),
        };
      });
      setRowNotes((p) => ({
        ...p,
        [k]: flagged
          ? `Still flagged as of ${new Date().toLocaleTimeString()}.`
          : fine
            ? "No longer a finding — re-scan to move it into the scanned list."
            : "This file is no longer in the folder. Re-scan.",
      }));
      if (!flagged) toggle(section.id, row, null);
    } catch (e) {
      setRowNotes((p) => ({ ...p, [k]: e instanceof Error ? e.message : "Re-check failed" }));
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submitPo} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-muted">Purchase order</span>
          <input
            value={poInput}
            onChange={(e) => setPoInput(e.target.value)}
            placeholder="PO number"
            className="mt-1 w-56 rounded-md border border-line px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={loading || !poInput.trim()}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Checking…" : "Run checks"}
        </button>
        {report ? (
          <button
            type="button"
            onClick={() => void scan(report.poNumber, supplierId)}
            disabled={loading || busy}
            className="rounded-md border border-line px-4 py-2 text-sm disabled:opacity-40"
          >
            Re-scan everything
          </button>
        ) : null}
      </form>

      {error ? (
        <Box tone="warn">
          ⚠ {error} — nothing was changed. A failed lookup is never treated as evidence that a file is
          missing.
        </Box>
      ) : null}

      {needsSupplier ? (
        <Box tone="mute">
          <p>
            PO “{po}” appears under {needsSupplier.length} suppliers, and each has its own folder. Pick one:
          </p>
          <ul className="mt-2 space-y-1">
            {needsSupplier.map((s) => (
              <li key={s.supplierId}>
                <button
                  type="button"
                  className="underline hover:text-ink"
                  onClick={() => {
                    setSupplierId(s.supplierId);
                    void scan(po, s.supplierId);
                  }}
                >
                  {s.supplierName ?? s.supplierId}
                </button>
              </li>
            ))}
          </ul>
        </Box>
      ) : null}

      {loading && !report ? <Box tone="mute">Reading the supplier&apos;s folder…</Box> : null}

      {report ? <ReportView
        report={report}
        history={history}
        selection={selection}
        selectedCount={selected.length}
        busy={busy}
        rowNotes={rowNotes}
        outcome={outcome}
        onToggle={toggle}
        onRecheck={recheckRow}
        onApplyOne={(section, row, action) => void apply([{ section, row, action }])}
        onConfirmBulk={() => setConfirming(true)}
      /> : null}

      {confirming ? (
        <ConfirmDialog
          rows={selectedRows}
          folderPath={report?.folderPath ?? null}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply(selectedRows)}
        />
      ) : null}
    </div>
  );
}

function ReportView(props: {
  report: PoChecksReport;
  history: HistoryRow[];
  selection: Map<string, CheckAction>;
  selectedCount: number;
  busy: boolean;
  rowNotes: Record<string, string>;
  outcome: AppliedAction[] | null;
  onToggle: (checkId: string, row: CheckRow, action: CheckAction | null) => void;
  onRecheck: (section: CheckSection, row: CheckRow) => void;
  onApplyOne: (section: CheckSection, row: CheckRow, action: CheckAction) => void;
  onConfirmBulk: () => void;
}) {
  const { report } = props;
  // Anything other than "ok" means the folder could not be listed, and the app
  // must not draw conclusions from a folder it could not read.
  if (report.state !== "ok" && report.state !== "subfolder-missing") {
    return <Box tone="warn">⚠ {report.message}</Box>;
  }
  if (report.sections.length === 0) {
    return <Box tone="mute">{report.message}</Box>;
  }

  const totalFlagged = report.sections.reduce((a, s) => a + s.flagged.length, 0);

  return (
    <div className="space-y-6">
      <div className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="font-medium">{report.poNumber}</span>
            <span className="text-muted"> · {report.supplierName ?? "supplier"}</span>
            <span className="text-muted">
              {" "}
              · {report.styles.length} style{report.styles.length === 1 ? "" : "s"} on this PO
            </span>
          </div>
          {report.folderUrl ? (
            <a href={report.folderUrl} target="_blank" rel="noreferrer" className="text-xs underline text-muted">
              Open the folder
            </a>
          ) : null}
        </div>
        {report.folderPath ? <div className="mt-1 text-xs text-faint">{report.folderPath}</div> : null}
        <div className="mt-1 text-xs text-muted">
          {report.styles.map((s) => s.styleName).join(", ")}
        </div>
      </div>

      {props.outcome ? <OutcomeBox applied={props.outcome} /> : null}

      {totalFlagged > 0 ? (
        <div className="sticky top-12 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-transparent bg-warn-soft px-4 py-3 text-sm">
          <span className="text-warn">
            {props.selectedCount} of {totalFlagged} flagged file{totalFlagged === 1 ? "" : "s"} selected.
          </span>
          <button
            type="button"
            disabled={props.selectedCount === 0 || props.busy}
            onClick={props.onConfirmBulk}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Review and apply {props.selectedCount || ""}
          </button>
          <span className="text-xs text-warn">
            You will see every file named before anything happens.
          </span>
        </div>
      ) : null}

      {report.sections.map((section) => (
        <SectionView key={section.id} section={section} {...props} />
      ))}

      <HistoryView rows={props.history} />
    </div>
  );
}

function SectionView({
  section,
  selection,
  busy,
  rowNotes,
  onToggle,
  onRecheck,
  onApplyOne,
}: {
  section: CheckSection;
  selection: Map<string, CheckAction>;
  busy: boolean;
  rowNotes: Record<string, string>;
  onToggle: (checkId: string, row: CheckRow, action: CheckAction | null) => void;
  onRecheck: (section: CheckSection, row: CheckRow) => void;
  onApplyOne: (section: CheckSection, row: CheckRow, action: CheckAction) => void;
}) {
  const [showOk, setShowOk] = useState(false);

  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{section.title}</h2>
        <p className="mt-1 text-xs text-muted">{section.description}</p>
        <p className="mt-2 text-xs text-faint">
          {section.scanned} file{section.scanned === 1 ? "" : "s"} scanned · {section.flagged.length} flagged
        </p>
      </header>

      {section.notes.map((n, i) => (
        <p key={i} className="border-b border-line bg-subtle px-4 py-2 text-xs text-muted">
          {n}
        </p>
      ))}

      {section.flagged.length === 0 ? (
        <p className="px-4 py-3 text-sm text-good">
          ✓ Nothing in this folder looks wrong to this check.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {section.flagged.map((row) => {
            const k = rowKey(section.id, row.id);
            const picked = selection.get(k) ?? null;
            return (
              <li key={row.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={row.allowed.length === 0 || busy}
                    checked={picked != null}
                    onChange={(e) => onToggle(section.id, row, e.target.checked ? (row.proposed ?? row.allowed[0]) : null)}
                    aria-label={`Select ${row.fileName}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <code className="break-all text-sm font-medium text-ink">{row.fileName}</code>
                      {row.owner ? <span className="text-xs text-muted">{row.owner.styleName}</span> : null}
                      {row.location !== "approved-layouts" ? (
                        <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">
                          PO folder
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-ink">{row.verdict}</p>
                    {row.detail ? <p className="mt-0.5 text-xs text-muted">{row.detail}</p> : null}

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {row.allowed.map((a) => (
                        <label key={a} className="flex items-center gap-1">
                          <input
                            type="radio"
                            name={`action-${k}`}
                            checked={picked === a}
                            disabled={busy}
                            onChange={() => onToggle(section.id, row, a)}
                          />
                          <span className={a === "delete" ? "text-bad" : "text-ink"}>
                            {a === "rename" ? `Rename to “${row.renameTo}”` : "Delete this file"}
                          </span>
                        </label>
                      ))}
                      {row.allowed.length === 0 ? (
                        <span className="text-faint">Report only — no action offered.</span>
                      ) : null}
                      {picked ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onApplyOne(section, row, picked)}
                          className="rounded border border-line px-2 py-1 disabled:opacity-40"
                        >
                          Apply to this file
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRecheck(section, row)}
                        className="rounded border border-line px-2 py-1 text-muted disabled:opacity-40"
                      >
                        Re-check
                      </button>
                      {row.webUrl ? (
                        <a href={row.webUrl} target="_blank" rel="noreferrer" className="underline text-muted">
                          Open
                        </a>
                      ) : null}
                    </div>
                    {rowNotes[k] ? <p className="mt-1 text-xs text-muted">{rowNotes[k]}</p> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Coverage. Shown as a count that opens, because "what did you actually
          look at?" is the question that makes a clean result believable. */}
      <div className="border-t border-line px-4 py-2">
        <button
          type="button"
          onClick={() => setShowOk((v) => !v)}
          className="text-xs text-muted underline hover:text-ink"
        >
          {showOk ? "Hide" : "Show"} the {section.ok.length} file{section.ok.length === 1 ? "" : "s"} that look
          right
        </button>
        {showOk ? (
          <ul className="mt-2 space-y-1">
            {section.ok.map((row) => (
              <li key={row.id} className="text-xs">
                <code className="break-all text-ink">{row.fileName}</code>
                <span className="text-faint"> — {row.verdict}</span>
              </li>
            ))}
            {section.ok.length === 0 ? <li className="text-xs text-faint">Nothing.</li> : null}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

// Names every affected file before anything happens — the whole point of the
// dialog. Deletes are listed first, separately, and never folded in with the
// renames: one of the two is reversible and the other is not.
function ConfirmDialog({
  rows,
  folderPath,
  busy,
  onCancel,
  onConfirm,
}: {
  rows: Array<{ section: CheckSection; row: CheckRow; action: CheckAction }>;
  folderPath: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const deletes = rows.filter((r) => r.action === "delete");
  const renames = rows.filter((r) => r.action === "rename");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(15_17_21/0.40)] p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-surface p-5 shadow-xl">
        <h2 className="text-base font-semibold">Confirm the changes to the supplier&apos;s folder</h2>
        {folderPath ? <p className="mt-1 text-xs text-muted">{folderPath}</p> : null}

        {deletes.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-bad">
              Permanently delete {deletes.length} file{deletes.length === 1 ? "" : "s"}
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              These leave the supplier&apos;s folder. The app cannot undo it — recovery means the SharePoint
              recycle bin.
            </p>
            <ul className="mt-2 space-y-1.5">
              {deletes.map(({ row }) => (
                <li key={row.id} className="text-xs">
                  <code className="break-all font-medium text-ink">{row.fileName}</code>
                  <div className="text-muted">{row.verdict}</div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {renames.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-ink">
              Rename {renames.length} file{renames.length === 1 ? "" : "s"} in place
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              Same file, same bytes, same version history — only the name changes.
            </p>
            <ul className="mt-2 space-y-1.5">
              {renames.map(({ row }) => (
                <li key={row.id} className="text-xs">
                  <code className="break-all text-muted">{row.fileName}</code>
                  <span className="text-faint"> → </span>
                  <code className="break-all font-medium text-ink">{row.renameTo}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-line px-4 py-2 text-sm disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${
              deletes.length > 0 ? "bg-bad" : "bg-primary"
            }`}
          >
            {busy
              ? "Working…"
              : deletes.length > 0
                ? `Delete ${deletes.length} and rename ${renames.length}`
                : `Rename ${renames.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function OutcomeBox({ applied }: { applied: AppliedAction[] }) {
  if (applied.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-subtle px-4 py-3 text-sm">
      <p className="font-medium text-ink">What happened</p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {applied.map((a, i) => (
          <li
            key={`${a.itemId}-${i}`}
            className={
              a.outcome === "done"
                ? "text-good"
                : a.outcome === "refused" || a.outcome === "failed" || a.outcome === "conflict"
                  ? "text-warn"
                  : "text-muted"
            }
          >
            {a.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The audit trail, scoped to this PO. Shown on the page rather than kept for a
// query later: the person about to delete something should be able to see what
// was already removed from this folder, and by whom.
function HistoryView({ rows }: { rows: HistoryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface px-4 py-3">
      <h2 className="text-sm font-semibold text-ink">What this page has already changed on this PO</h2>
      <ul className="mt-2 space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.id} className="text-muted">
            <span className="text-faint">{new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")}</span>{" "}
            <span className={r.action === "delete" ? "text-bad" : "text-ink"}>{r.action}</span>{" "}
            <code className="break-all">{r.fileName}</code>
            {r.newFileName ? <span> → <code className="break-all">{r.newFileName}</code></span> : null}
            <span className="text-faint"> · {r.outcome}</span>
            {r.userEmail ? <span className="text-faint"> · {r.userEmail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Box({ tone, children }: { tone: "mute" | "warn"; children: React.ReactNode }) {
  const cls =
    tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-zinc-200 bg-zinc-50 text-zinc-600";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

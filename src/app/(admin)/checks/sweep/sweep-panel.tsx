"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { CheckAction, FileLocation } from "@/lib/checks/po-checks";
import type { FindingGroup, SweepStatus } from "@/lib/checks/sweep";

// =====================================================
// Progress you can watch, walk away from, and come back to; then the findings
// of the whole book, grouped by fault.
//
// TWO THINGS THIS COMPONENT DELIBERATELY CANNOT DO.
//
//   • It cannot repair anything. There is no bulk apply, and no endpoint behind
//     one. Every file row links to that PO's own check, which re-runs the whole
//     check against the LIVE folder and refuses any file that has changed since
//     — the guard that matters more here than anywhere, because a sweep's rows
//     are hours old by the time they are read.
//   • It cannot make a clean-looking page out of a Graph outage. Folders the
//     sweep could not read are counted and listed separately from folders it
//     read and found nothing in. The two are not the same answer and are never
//     shown as though they were.
//
// Polling rather than streaming: an hour-long run reports through the database,
// and a poll survives the tab being closed, the laptop sleeping and the server
// being redeployed — none of which a stream does.
// =====================================================

type ProblemRow = {
  supplierId: string;
  poNumber: string;
  supplierName: string | null;
  state: string;
  message: string | null;
  error: string | null;
};

type FileRow = {
  supplierId: string;
  poNumber: string;
  supplierName: string | null;
  fileName: string;
  webUrl: string | null;
  verdict: string;
  detail: string | null;
  owner: { styleId: string; styleName: string } | null;
  proposed: CheckAction | null;
  allowed: CheckAction[];
  renameTo: string | null;
  location: FileLocation;
};

type SweepResponse = {
  sweep: SweepStatus | null;
  groups?: FindingGroup[];
  files?: FileRow[];
  problems?: ProblemRow[];
  kind?: string | null;
  error?: string;
};

const POLL_MS = 4000;

export function SweepPanel() {
  const [data, setData] = useState<SweepResponse | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The read, with no state in it — the effects below own when it lands, which
  // is what keeps a poll from writing into an unmounted page.
  const fetchSweep = useCallback(async (forKind: string | null): Promise<SweepResponse> => {
    const qs = forKind ? `?kind=${encodeURIComponent(forKind)}` : "";
    const res = await fetch(`/api/admin/checks/sweep${qs}`);
    const body = (await res.json().catch(() => ({}))) as SweepResponse;
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }, []);

  const load = useCallback(
    (forKind: string | null, alive: () => boolean = () => true) =>
      fetchSweep(forKind)
        .then((body) => {
          if (!alive()) return;
          setData(body);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!alive()) return;
          setError(e instanceof Error ? e.message : "Could not read the sweep");
        }),
    [fetchSweep],
  );

  useEffect(() => {
    let alive = true;
    void load(kind, () => alive);
    return () => {
      alive = false;
    };
  }, [load, kind]);

  // Keep polling while a run is live — and while it is stalled, so the moment
  // somebody (or the cron) resumes it the page follows along.
  const running = data?.sweep?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const t = setInterval(() => void load(kind, () => alive), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [running, load, kind]);

  async function post(action: "start" | "cancel") {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/checks/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sweepId: data?.sweep?.id }),
      });
      const body = (await res.json().catch(() => ({}))) as SweepResponse;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setError(null);
      await load(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const sweep = data?.sweep ?? null;
  const groups = data?.groups ?? [];
  const problems = data?.problems ?? [];
  const files = data?.files ?? [];
  const done = sweep ? sweep.totalPos - sweep.pendingPos : 0;
  const pct = sweep && sweep.totalPos > 0 ? Math.round((done / sweep.totalPos) * 100) : 0;

  return (
    <div className="space-y-6">
      {error ? (
        <Box tone="warn">
          ⚠ {error} — nothing was changed. Everything the sweep had already checked is kept.
        </Box>
      ) : null}

      {/* ── Run control + progress ───────────────────────────────────── */}
      <div className="rounded-lg border border-zinc-200 p-4">
        {!sweep ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-600">
              No sweep has been run yet. It works through every purchase order at or above the
              supplier-send cutoff, one folder at a time, and takes roughly an hour.
            </p>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Start the sweep
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {sweep.status === "RUNNING" && !sweep.stalled
                    ? "Running"
                    : sweep.status === "RUNNING"
                      ? "Interrupted — resumable"
                      : sweep.status === "DONE"
                        ? "Finished"
                        : sweep.status === "CANCELLED"
                          ? "Stopped"
                          : "Stopped early"}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {done} of {sweep.totalPos} purchase orders
                  {sweep.minPo != null ? ` at or above PO ${sweep.minPo}` : ""} · started{" "}
                  {new Date(sweep.startedAt).toLocaleString()}
                  {sweep.startedByEmail ? ` by ${sweep.startedByEmail}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                {sweep.status === "RUNNING" && !sweep.stalled ? (
                  <button
                    type="button"
                    onClick={() => void post("cancel")}
                    disabled={busy}
                    className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => (sweep.status === "RUNNING" ? void post("start") : setConfirming(true))}
                    disabled={busy}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {sweep.status === "RUNNING" ? "Resume" : "Start a new sweep"}
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full bg-zinc-900 transition-all" style={{ width: `${pct}%` }} />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <Stat label="Files flagged" value={String(sweep.flaggedFiles)} tone={sweep.flaggedFiles > 0 ? "warn" : "ok"} />
              <Stat label="POs with findings" value={String(sweep.posWithFindings)} />
              <Stat
                label="Folders unreadable"
                value={String(sweep.unreadablePos)}
                tone={sweep.unreadablePos > 0 ? "warn" : "ok"}
                hint="Not the same as clean — the folder could not be listed"
              />
              <Stat label="Checks that failed" value={String(sweep.erroredPos)} tone={sweep.erroredPos > 0 ? "warn" : "ok"} />
            </div>

            {sweep.status === "RUNNING" && sweep.stalled ? (
              <Box tone="mute" className="mt-3">
                This sweep&apos;s process is gone — almost always a deploy. Everything it had already
                checked is kept; resuming picks up from the folders it never reached.
              </Box>
            ) : null}
            {sweep.error ? <Box tone="warn" className="mt-3">{sweep.error}</Box> : null}
          </>
        )}
      </div>

      {confirming ? (
        <Box tone="mute">
          <p className="font-medium">Start a sweep of every purchase order?</p>
          <p className="mt-1 text-sm text-zinc-600">
            It reads every PO folder in SharePoint, one at a time, for about an hour. It is read-only —
            nothing is renamed or removed by the sweep itself. You can leave the page; it keeps going,
            and it survives a deploy.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void post("start")}
              disabled={busy}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "Starting…" : "Start"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </Box>
      ) : null}

      {/* ── The findings of the whole book, by fault ─────────────────── */}
      {sweep ? (
        <div>
          <h2 className="text-lg font-semibold">What is wrong, across every folder</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Grouped by the fault rather than by the folder — the same verdicts each PO&apos;s own check
            would show. Open a group to see the files and the order each one is in.
          </p>

          {groups.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              {sweep.checkedPos === 0
                ? "Nothing checked yet."
                : "✓ Nothing flagged in any folder checked so far."}
            </p>
          ) : (
            <div className="mt-4 space-y-2">
              {groups.map((g) => (
                <div key={g.kind} className="rounded-lg border border-zinc-200">
                  <button
                    type="button"
                    onClick={() => setKind(kind === g.kind ? null : g.kind)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-50"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        <SeverityDot severity={g.severity} /> {g.title}
                      </p>
                      <p className="mt-0.5 max-w-3xl text-xs text-zinc-500">{g.blurb}</p>
                    </div>
                    <div className="whitespace-nowrap text-sm text-zinc-600">
                      {g.files} file{g.files === 1 ? "" : "s"} · {g.pos} PO{g.pos === 1 ? "" : "s"}
                    </div>
                  </button>

                  {kind === g.kind ? (
                    <div className="border-t border-zinc-200 px-4 py-3">
                      <p className="text-xs text-zinc-500">
                        Repairs happen on the PO&apos;s own check, which re-reads the folder live and
                        refuses anything that has changed since this scan.
                      </p>
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[46rem] text-sm">
                          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                            <tr>
                              <th className="py-1 pr-3">Purchase order</th>
                              <th className="py-1 pr-3">File</th>
                              <th className="py-1 pr-3">Verdict</th>
                              <th className="py-1">Open</th>
                            </tr>
                          </thead>
                          <tbody>
                            {files.map((f, i) => (
                              <tr key={`${f.supplierId}:${f.poNumber}:${f.fileName}:${i}`} className="border-t border-zinc-100 align-top">
                                <td className="py-2 pr-3 whitespace-nowrap">
                                  <span className="font-medium">{f.poNumber}</span>
                                  {f.supplierName ? (
                                    <span className="block text-xs text-zinc-500">{f.supplierName}</span>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-3">
                                  <span className="break-all font-mono text-xs">{f.fileName}</span>
                                  {f.renameTo ? (
                                    <span className="block break-all text-xs text-zinc-500">
                                      → {f.renameTo}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-3 text-xs text-zinc-600">
                                  {f.verdict}
                                  {f.location !== "approved-layouts" ? (
                                    <span className="block text-zinc-400">In the PO folder, not APPROVED LAYOUTS — reported only.</span>
                                  ) : null}
                                </td>
                                <td className="py-2 whitespace-nowrap">
                                  <Link
                                    href={`/checks?po=${encodeURIComponent(f.poNumber)}&supplier=${encodeURIComponent(f.supplierId)}`}
                                    className="text-xs font-medium text-zinc-900 underline"
                                  >
                                    Check this PO
                                  </Link>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {files.length === 0 ? (
                          <p className="py-2 text-xs text-zinc-500">Loading…</p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* ── Folders that could not be read ───────────────────────────── */}
      {problems.length > 0 ? (
        <div>
          <h2 className="text-lg font-semibold">Folders the sweep could not read</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            These are NOT clean folders. A permission gap, a throttle or an ambiguous PO folder means the
            sweep has no evidence about them either way.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-1 pr-3">Purchase order</th>
                  <th className="py-1 pr-3">State</th>
                  <th className="py-1">Why</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((p) => (
                  <tr key={`${p.supplierId}:${p.poNumber}`} className="border-t border-zinc-100 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <Link
                        href={`/checks?po=${encodeURIComponent(p.poNumber)}&supplier=${encodeURIComponent(p.supplierId)}`}
                        className="font-medium underline"
                      >
                        {p.poNumber}
                      </Link>
                      {p.supplierName ? <span className="block text-xs text-zinc-500">{p.supplierName}</span> : null}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-xs">{p.state}</td>
                    <td className="py-2 text-xs text-zinc-600">{p.error ?? p.message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SeverityDot({ severity }: { severity: 0 | 1 | 2 }) {
  const cls = severity === 0 ? "bg-amber-500" : severity === 1 ? "bg-zinc-400" : "bg-emerald-500";
  return <span className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${cls}`} />;
}

function Stat({
  label,
  value,
  tone = "mute",
  hint,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "mute";
  hint?: string;
}) {
  const cls = tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "text-zinc-900";
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
      {hint ? <div className="text-xs text-zinc-400">{hint}</div> : null}
    </div>
  );
}

function Box({
  tone,
  children,
  className = "",
}: {
  tone: "warn" | "mute";
  children: React.ReactNode;
  className?: string;
}) {
  const cls =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-zinc-200 bg-zinc-50 text-zinc-700";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls} ${className}`}>{children}</div>;
}

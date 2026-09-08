import { runPoChecks, type PoChecksReport } from "./run-po-checks";
import { listDeliverablePoKeys } from "@/lib/sharepoint/po-delivery-run";
import {
  graphThrottleWaitMs,
  graphThrottleStreak,
  noteGraphSuccess,
} from "@/lib/sharepoint/graph-throttle";
import { CHECK_ROW_KINDS, type CheckId, type CheckRow, type CheckRowKind } from "./po-checks";

// =====================================================
// The same folder audit /checks runs on ONE purchase order, run across every
// order in scope — because the value of these checks is "every stale-named
// file in the book", and one folder at a time never gets there.
//
// FOUR THINGS THIS MODULE IS NOT ALLOWED TO DO.
//
//  1. IT DOES NOT FORK THE CHECK. Every PO goes through runPoChecks, unchanged
//     and unparameterised. A sweep that judged files by its own slightly
//     different rules would be worse than no sweep: the two surfaces would
//     disagree about which files are strays, and a person would act on
//     whichever they happened to open.
//  2. IT DOES NOT WRITE TO SHAREPOINT, and there is no path from here into
//     apply-actions.ts. A sweep's findings are stale BY DEFINITION — the
//     folder is scanned once and read hours later — so the re-check that
//     apply performs stops being belt-and-braces and becomes the thing that
//     keeps a bulk repair honest. Acting on a finding means opening that PO's
//     own page, where the check is re-run live and every file is confirmed by
//     name. The sweep's whole job is to say WHICH folders are worth opening.
//  3. IT DOES NOT FAN OUT HARDER TO GO FASTER. Exactly one purchase order is
//     in flight at a time; inside it the per-style pool is STYLE_CONCURRENCY,
//     untouched. ~370 orders at a few seconds each is about an hour, and an
//     hour is the correct answer — a sweep that finished in ten minutes by
//     tripling the Graph traffic would be throttled into taking longer, and
//     would slow every other SharePoint surface while it did.
//  4. IT DOES NOT KEEP GOING THROUGH AN OUTAGE. A run of folders that cannot
//     be listed is not a run of findings; it is one failure repeated. The
//     sweep stops and says so, rather than recording a few hundred rows that
//     read as "we looked and there was nothing there".
//
// HOW IT SURVIVES A DEPLOY. The PO list is written up front, one row per
// (supplier, PO), and each row is filled in the moment its folder is checked.
// The process holds a heartbeat lease on the run. A deploy kills the process
// mid-sweep; the lease goes cold; a resume picks up the rows still marked
// "pending" and the ones already done are simply not re-checked. Nothing is
// held in memory that a restart would lose.
// =====================================================

// How long a heartbeat may go unrefreshed before the run counts as abandoned.
// Comfortably longer than one folder check (a wide PO takes ~10s) and shorter
// than anyone's patience with a stuck progress bar.
export const SWEEP_STALE_MS = 3 * 60_000;

// Consecutive unreadable folders that mean "this is Graph, not the folders".
export const MAX_CONSECUTIVE_UNREADABLE = 10;

// Consecutive throttles before the run gives up rather than crawling. Each one
// has already been retried by the Graph client's own retry handler.
export const MAX_THROTTLE_STREAK = 5;

// The most flagged rows stored for one PO. A folder with more findings than
// this is a situation, not a list; the count stays exact either way.
export const MAX_STORED_FINDINGS = 500;

// A folder state that means the check actually SAW the folder. Anything else
// is an absence of evidence — the same distinction /delivery draws, and for
// the same reason.
const LISTABLE = new Set(["ok", "subfolder-missing"]);

// One flagged file, as stored. The check's own row plus which check produced
// it — nothing derived, so the review surface shows exactly the verdict the
// per-PO page would have shown.
export type SweepFinding = CheckRow & { checkId: CheckId };

export type SweepStatus = {
  id: string;
  status: "RUNNING" | "DONE" | "CANCELLED" | "FAILED";
  // True when the status says RUNNING but the heartbeat has gone cold: the
  // process that owned this run is gone (almost always a deploy) and it can be
  // resumed from where it stopped.
  stalled: boolean;
  minPo: number | null;
  totalPos: number;
  checkedPos: number;
  pendingPos: number;
  unreadablePos: number;
  erroredPos: number;
  posWithFindings: number;
  flaggedFiles: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  startedByEmail: string | null;
  error: string | null;
};

// -----------------------------------------------------
// Pure — the cross-order rollup
// -----------------------------------------------------

export type FindingGroup = {
  kind: CheckRowKind;
  title: string;
  blurb: string;
  severity: 0 | 1 | 2;
  files: number;
  pos: number;
  // A rename target exists for every file in the group, so the repair is
  // mechanical. Shown so an operator can tell "300 files, all renames" from
  // "300 files, all judgement calls".
  renameable: number;
  deletable: number;
};

export type SweepPoFindings = {
  supplierId: string;
  poNumber: string;
  poSeq: number | null;
  supplierName: string | null;
  folderUrl: string | null;
  findings: SweepFinding[];
};

// One PO's findings, counted by fault. Stored alongside the findings so the
// cross-order rollup — which a running sweep re-reads every few seconds — costs
// a few hundred bytes per order instead of every flagged row in the book.
export type KindHistogram = Partial<
  Record<CheckRowKind, { files: number; renameable: number; deletable: number }>
>;

// Pure. One PO's rows → its histogram.
export function summariseFindings(findings: readonly SweepFinding[]): KindHistogram {
  const out: KindHistogram = {};
  for (const f of findings) {
    const e = (out[f.kind] ??= { files: 0, renameable: 0, deletable: 0 });
    e.files += 1;
    if (f.allowed.includes("rename")) e.renameable += 1;
    if (f.allowed.includes("delete")) e.deletable += 1;
  }
  return out;
}

// Pure. Every PO's histogram → the book's findings by FAULT, worst first. The
// whole point of the sweep: "12 covers are under their old name, all of them
// renameable" is a repair someone can plan, where "PO x has 3 findings, PO y
// has 1" is three hundred rows of nothing.
export function groupHistograms(rows: readonly KindHistogram[]): FindingGroup[] {
  const byKind = new Map<CheckRowKind, { files: number; pos: number; renameable: number; deletable: number }>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!v || v.files === 0) continue;
      const kind = k as CheckRowKind;
      const g = byKind.get(kind) ?? { files: 0, pos: 0, renameable: 0, deletable: 0 };
      g.files += v.files;
      g.pos += 1;
      g.renameable += v.renameable;
      g.deletable += v.deletable;
      byKind.set(kind, g);
    }
  }
  return [...byKind.entries()]
    .map(([kind, g]) => ({
      kind,
      title: CHECK_ROW_KINDS[kind]?.title ?? kind,
      blurb: CHECK_ROW_KINDS[kind]?.blurb ?? "",
      severity: CHECK_ROW_KINDS[kind]?.severity ?? 1,
      ...g,
    }))
    .sort((a, b) => a.severity - b.severity || b.files - a.files || a.kind.localeCompare(b.kind));
}

// The same rollup straight from the rows — what a test asserts on, and the
// definition the stored histograms have to agree with.
export function groupFindings(pos: readonly SweepPoFindings[]): FindingGroup[] {
  return groupHistograms(pos.map((p) => summariseFindings(p.findings)));
}

// The flagged rows a report contributes, in the order the page shows them.
export function findingsOf(report: PoChecksReport): SweepFinding[] {
  const out: SweepFinding[] = [];
  for (const section of report.sections) {
    for (const row of section.flagged) out.push({ ...row, checkId: section.id });
  }
  return out;
}

// -----------------------------------------------------
// Lifecycle
// -----------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Never sleep past the point of noticing a cancel. A long throttle wait is
// served in slices so "Stop" stays responsive.
const SLEEP_SLICE_MS = 5_000;

export class SweepBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepBusyError";
  }
}

// Start a new run, or take over one whose process is gone.
//
// A run whose heartbeat is still warm is REFUSED rather than duplicated: two
// loops on one row set would each re-check whatever the other had not yet
// claimed, doubling the Graph spend for the same answer.
export async function startOrResumeSweep(input: {
  userId?: string | null;
  userEmail?: string | null;
}): Promise<{ sweepId: string; resumed: boolean }> {
  const { db } = await import("@/lib/db");

  const live = await db.folderCheckSweep.findFirst({
    where: { status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });

  if (live) {
    const cold = Date.now() - live.heartbeatAt.getTime() > SWEEP_STALE_MS;
    if (!cold) {
      throw new SweepBusyError(
        "A sweep is already running. Watch it here, or stop it before starting another.",
      );
    }
    // Take the lease, but only if nobody else did between the read and now.
    const claimed = await db.folderCheckSweep.updateMany({
      where: { id: live.id, status: "RUNNING", heartbeatAt: live.heartbeatAt },
      data: { heartbeatAt: new Date(), error: null },
    });
    if (claimed.count !== 1) {
      throw new SweepBusyError("Another process just picked that sweep up. Give it a moment.");
    }
    void detach(live.id);
    return { sweepId: live.id, resumed: true };
  }

  // Scope exactly as every other PO-folder surface does — the supplier-send
  // cutoff, read through listDeliverablePoKeys. Below it nothing is
  // deliverable by policy, so a stray file there is not this sweep's finding.
  const keys = await listDeliverablePoKeys();
  const { getSupplierSendMinPo } = await import("@/lib/settings/app-settings");
  const minPo = await getSupplierSendMinPo().catch(() => null);

  const sweep = await db.folderCheckSweep.create({
    data: {
      status: "RUNNING",
      minPo,
      totalPos: keys.length,
      startedById: input.userId ?? null,
      startedByEmail: input.userEmail ?? null,
    },
    select: { id: true },
  });

  // The whole PO list, up front. This is what makes the run resumable: after
  // this insert nothing about the run's SCOPE lives in the process.
  for (let i = 0; i < keys.length; i += 200) {
    await db.folderCheckSweepPo.createMany({
      data: keys.slice(i, i + 200).map((k) => ({
        sweepId: sweep.id,
        supplierId: k.supplierId,
        poNumber: k.poNumber,
        poSeq: k.poSeq,
      })),
      skipDuplicates: true,
    });
  }

  void detach(sweep.id);
  return { sweepId: sweep.id, resumed: false };
}

// Fire-and-forget. The caller is an HTTP request and must not wait an hour;
// the loop's own progress is in the database, so nothing is lost by letting go
// of this promise — but a rejection still has to be recorded rather than
// vanish into an unhandled rejection.
function detach(sweepId: string): Promise<void> {
  return runSweepLoop(sweepId).catch(async (err) => {
    console.error(`[checks-sweep] run ${sweepId} died:`, err);
    const { db } = await import("@/lib/db");
    await db.folderCheckSweep
      .updateMany({
        where: { id: sweepId, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: err instanceof Error ? err.message.slice(0, 500) : "The sweep failed",
        },
      })
      .catch(() => {});
  });
}

export async function cancelSweep(sweepId: string): Promise<void> {
  const { db } = await import("@/lib/db");
  await db.folderCheckSweep.updateMany({
    where: { id: sweepId, status: "RUNNING" },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
}

// Resume a run whose process is gone, if there is one. The cron entry point —
// with it scheduled a deploy mid-sweep costs minutes rather than a restart by
// hand; without it, the page's Resume button does the same thing.
export async function resumeStalledSweep(): Promise<{ resumed: string | null }> {
  const { db } = await import("@/lib/db");
  const live = await db.folderCheckSweep.findFirst({
    where: { status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });
  if (!live) return { resumed: null };
  if (Date.now() - live.heartbeatAt.getTime() <= SWEEP_STALE_MS) return { resumed: null };
  const claimed = await db.folderCheckSweep.updateMany({
    where: { id: live.id, status: "RUNNING", heartbeatAt: live.heartbeatAt },
    data: { heartbeatAt: new Date(), error: null },
  });
  if (claimed.count !== 1) return { resumed: null };
  void detach(live.id);
  return { resumed: live.id };
}

// -----------------------------------------------------
// The loop
// -----------------------------------------------------

async function runSweepLoop(sweepId: string): Promise<void> {
  const { db } = await import("@/lib/db");
  let consecutiveUnreadable = 0;

  const stop = async (status: "DONE" | "FAILED", error: string | null) => {
    await db.folderCheckSweep.updateMany({
      where: { id: sweepId, status: "RUNNING" },
      data: { status, finishedAt: new Date(), error, heartbeatAt: new Date() },
    });
  };

  for (;;) {
    // Re-read the status every lap: this is how Stop is noticed, and how a
    // second process that stole the lease makes this one bow out.
    const sweep = await db.folderCheckSweep.findUnique({
      where: { id: sweepId },
      select: { status: true },
    });
    if (!sweep || sweep.status !== "RUNNING") return;

    // Graph asked us to slow down — served in slices so a cancel still lands
    // promptly. See graph-throttle.ts: by the time a 429 reaches us the SDK
    // has already retried it, so this is sustained throttling.
    const wait = graphThrottleWaitMs();
    if (wait > 0) {
      await db.folderCheckSweep.updateMany({ where: { id: sweepId }, data: { heartbeatAt: new Date() } });
      await sleep(Math.min(wait, SLEEP_SLICE_MS));
      continue;
    }
    if (graphThrottleStreak() >= MAX_THROTTLE_STREAK) {
      await stop(
        "FAILED",
        "SharePoint kept asking us to slow down, so the sweep stopped rather than hammering it. Resume it later — everything checked so far is kept.",
      );
      return;
    }

    // Newest orders first: they are the ones people are working on, so a sweep
    // that is stopped half way has still answered the useful half.
    const next = await db.folderCheckSweepPo.findFirst({
      where: { sweepId, state: "pending" },
      orderBy: [{ poSeq: "desc" }, { poNumber: "desc" }],
      select: { id: true, supplierId: true, poNumber: true },
    });
    if (!next) {
      await stop("DONE", null);
      return;
    }

    let report: PoChecksReport | null = null;
    let failure: string | null = null;
    try {
      report = await runPoChecks({ supplierId: next.supplierId, poNumber: next.poNumber });
    } catch (err) {
      failure = err instanceof Error ? err.message.slice(0, 300) : "The check failed";
    }

    const listable = report != null && LISTABLE.has(report.state);
    if (listable) {
      consecutiveUnreadable = 0;
      noteGraphSuccess();
    } else {
      consecutiveUnreadable += 1;
    }

    const findings = report ? findingsOf(report) : [];
    const stored = findings.slice(0, MAX_STORED_FINDINGS);
    const notes = report ? report.sections.flatMap((s) => s.notes) : [];
    if (findings.length > stored.length) {
      notes.push(
        `${findings.length - stored.length} further flagged file(s) are not listed here — open the PO's own check to see them all.`,
      );
    }

    await db.$transaction([
      db.folderCheckSweepPo.update({
        where: { id: next.id },
        data: {
          state: report ? report.state : "error",
          message: report?.message ?? null,
          folderUrl: report?.folderUrl ?? null,
          supplierName: report?.supplierName ?? null,
          styleCount: report?.styles.length ?? 0,
          scannedFiles: report ? report.sections.reduce((a, s) => a + s.scanned, 0) : 0,
          flaggedFiles: findings.length,
          findings: stored,
          // Counted from ALL the findings, not just the stored slice: a folder
          // with more findings than we list must still be counted honestly.
          kindCounts: summariseFindings(findings),
          notes,
          checkedAt: new Date(),
          error: failure,
        },
      }),
      db.folderCheckSweep.update({
        where: { id: sweepId },
        data: {
          heartbeatAt: new Date(),
          checkedPos: { increment: 1 },
          unreadablePos: { increment: report != null && !listable ? 1 : 0 },
          erroredPos: { increment: report == null ? 1 : 0 },
          posWithFindings: { increment: findings.length > 0 ? 1 : 0 },
          flaggedFiles: { increment: findings.length },
        },
      }),
    ]);

    // A run of folders we could not read is ONE failure repeated, not a
    // finding per folder. Recording a few hundred of them would leave a page
    // that reads "we looked and there was nothing there" for the whole book.
    if (consecutiveUnreadable >= MAX_CONSECUTIVE_UNREADABLE) {
      await stop(
        "FAILED",
        `${consecutiveUnreadable} folders in a row could not be read, so the sweep stopped rather than recording a Graph outage as a result. Resume it once SharePoint is answering again — everything checked so far is kept.`,
      );
      return;
    }
  }
}

// -----------------------------------------------------
// Reads for the page
// -----------------------------------------------------

// P2021-hardened for the same reason every other new table's read is: Railway
// runs `prisma migrate deploy` before `npm start`, so a missing table should be
// impossible — but a migration that failed while the container still served
// would otherwise turn this page into a 500, and "no sweep yet" is the honest
// answer either way.
function absentTable(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2021";
}

export async function loadSweepStatus(sweepId?: string): Promise<SweepStatus | null> {
  const { db } = await import("@/lib/db");
  try {
    const sweep = sweepId
      ? await db.folderCheckSweep.findUnique({ where: { id: sweepId } })
      : await db.folderCheckSweep.findFirst({ orderBy: { startedAt: "desc" } });
    if (!sweep) return null;
    const pending = await db.folderCheckSweepPo.count({ where: { sweepId: sweep.id, state: "pending" } });
    return {
      id: sweep.id,
      status: sweep.status as SweepStatus["status"],
      stalled: sweep.status === "RUNNING" && Date.now() - sweep.heartbeatAt.getTime() > SWEEP_STALE_MS,
      minPo: sweep.minPo,
      totalPos: sweep.totalPos,
      checkedPos: sweep.checkedPos,
      pendingPos: pending,
      unreadablePos: sweep.unreadablePos,
      erroredPos: sweep.erroredPos,
      posWithFindings: sweep.posWithFindings,
      flaggedFiles: sweep.flaggedFiles,
      startedAt: sweep.startedAt.toISOString(),
      heartbeatAt: sweep.heartbeatAt.toISOString(),
      finishedAt: sweep.finishedAt?.toISOString() ?? null,
      startedByEmail: sweep.startedByEmail,
      error: sweep.error,
    };
  } catch (err) {
    if (absentTable(err)) return null;
    throw err;
  }
}

// The rollup input, and nothing else. This is what a running sweep's progress
// poll reads every few seconds, so it must never carry the findings themselves:
// a few hundred orders' flagged rows is megabytes, and a poll that size would
// make watching the sweep more expensive than running it.
export async function loadSweepKindCounts(sweepId: string): Promise<KindHistogram[]> {
  const { db } = await import("@/lib/db");
  try {
    const rows = await db.folderCheckSweepPo.findMany({
      where: { sweepId, flaggedFiles: { gt: 0 } },
      select: { kindCounts: true },
    });
    return rows.map((r) => (r.kindCounts && typeof r.kindCounts === "object" ? (r.kindCounts as KindHistogram) : {}));
  } catch (err) {
    if (absentTable(err)) return [];
    throw err;
  }
}

// Every PO in the sweep that has something flagged, with its rows. Only read
// when a group has actually been opened — see loadSweepKindCounts for the
// progress path. Clean POs are a count, never a payload.
export async function loadSweepFindings(sweepId: string): Promise<SweepPoFindings[]> {
  const { db } = await import("@/lib/db");
  try {
    const rows = await db.folderCheckSweepPo.findMany({
      where: { sweepId, flaggedFiles: { gt: 0 } },
      orderBy: [{ poSeq: "desc" }, { poNumber: "desc" }],
      select: {
        supplierId: true,
        poNumber: true,
        poSeq: true,
        supplierName: true,
        folderUrl: true,
        findings: true,
      },
    });
    return rows.map((r) => ({
      supplierId: r.supplierId,
      poNumber: r.poNumber,
      poSeq: r.poSeq,
      supplierName: r.supplierName,
      folderUrl: r.folderUrl,
      findings: Array.isArray(r.findings) ? (r.findings as unknown as SweepFinding[]) : [],
    }));
  } catch (err) {
    if (absentTable(err)) return [];
    throw err;
  }
}

// The folders the sweep could not read, and the ones whose check threw. Kept
// apart from the findings for the reason the whole module keeps repeating: an
// unreadable folder is not a clean one.
export async function loadSweepProblems(sweepId: string) {
  const { db } = await import("@/lib/db");
  try {
    return await db.folderCheckSweepPo.findMany({
      where: { sweepId, state: { notIn: ["pending", "ok", "subfolder-missing"] } },
      orderBy: [{ poSeq: "desc" }, { poNumber: "desc" }],
      select: {
        supplierId: true,
        poNumber: true,
        supplierName: true,
        state: true,
        message: true,
        error: true,
      },
    });
  } catch (err) {
    if (absentTable(err)) return [];
    throw err;
  }
}

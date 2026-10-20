import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { getPoEanAutoRunEnabled, getAutomationMinPo } from "@/lib/settings/app-settings";
import { toEanSize } from "@/lib/po/ean-view";
import { PoEansTable, type PoEanRow, type PoEanFilter } from "./po-eans-table";
import { PoEanAutoRunSetting } from "./po-ean-auto-run-setting";
import { requireAdminPage } from "@/lib/auth-server";
import {
  EAN_STATUS_META,
  FLOATABLE_STATUSES,
  MAX_EAN_ATTEMPTS,
  eanLane,
} from "@/lib/po/ean-status-meta";
import type { StyleEanStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

// Filtered views (a status, or the gave-up set) can hold more than the default
// recent window so a deep-linked badge (e.g. "gave up 74") lands on the whole
// set, not a recent slice.
const FILTERED_TAKE = 500;

// How deep to read the recycle queue when estimating "next check". Beyond this
// the estimate saturates (reported as the far end of the queue) rather than
// costing an unbounded scan — the in-scope pile is cutoff-bounded and small.
const RECYCLE_QUEUE_SCAN = 2000;

// The Colour code ("🎨 Color Code" dropdown, e.g. "*A"/"*B") off the raw Monday
// snapshot. Two colourways of the same style share a style NUMBER but differ by
// this code + PO, so surfacing it disambiguates otherwise-identical rows. Reads
// the mapped column then the manual fallback (matches DEFAULT_COLUMN_MAPPING);
// empty when the style carries no colour code.
function readColourCode(rawData: unknown): string {
  const cols = (rawData as { column_values?: Array<{ id?: string; text?: string | null; display_value?: string | null }> })
    ?.column_values;
  if (!Array.isArray(cols)) return "";
  for (const id of ["dropdown__1", "manual.colourCode"]) {
    const c = cols.find((x) => x.id === id);
    const v = (c?.text ?? "").trim() || (c?.display_value ?? "").trim();
    if (v) return v;
  }
  return "";
}

// PO → EAN resolution. Every style that carries a PO number is shown with its
// persisted resolution state: resolution is queued automatically when the PO
// is filled (Monday sync) and drained by the EAN runner, which scrapes the
// matching Purchase Order PDF from the central Suppliers SharePoint library
// and stores the per-size/colour Barcode EAN (in size order) + the carton EAN
// on the style. "Re-resolve" forces a fresh read.
export const metadata = { title: "PO barcodes" };

export default async function PoEansPage({
  searchParams,
}: {
  // scope = active/parked PO-cutoff view; status / floated are the deep-link
  // filters from the /automation EAN queue chips.
  searchParams: Promise<{ scope?: string; status?: string; floated?: string }>;
}) {
  await requireAdminPage();

  const sp = await searchParams;
  const [autoRunEnabled, minPo] = await Promise.all([
    getPoEanAutoRunEnabled(),
    getAutomationMinPo(),
  ]);

  // Deep-link filters. "floated" is a global triage view (every gave-up row,
  // regardless of cutoff scope) so the /automation count and the landed set
  // always agree; "status" composes with the active/parked scope below.
  const floatedActive = sp.floated === "1";
  const statusActive: StyleEanStatus | null =
    !floatedActive && sp.status && sp.status in EAN_STATUS_META
      ? (sp.status as StyleEanStatus)
      : null;
  const activeFilter: PoEanFilter = floatedActive
    ? { kind: "floated" }
    : statusActive
      ? { kind: "status", value: statusActive }
      : null;

  // The queue view follows the automation PO cutoff: "active" = the POs the
  // automation actually touches (poSeq >= cutoff); "parked" = the backlog below
  // it (still here, still manually scrape-able per row). No cutoff ⇒ one
  // undivided list. The floated triage spans both scopes.
  const viewingParked = !floatedActive && minPo !== null && sp.scope === "parked";
  const scopeWhere: Prisma.StyleWhereInput =
    minPo === null || floatedActive
      ? {}
      : viewingParked
        ? { OR: [{ poSeq: { lt: minPo } }, { poSeq: null }] }
        : { poSeq: { gte: minPo } };

  // Same predicate the /automation "gave up" badge counts with, so the count
  // and the landed set always agree.
  const floatedWhere: Prisma.StyleWhereInput = {
    poNumber: { not: null },
    eanStatus: { in: [...FLOATABLE_STATUSES] },
    eanAttempts: { gte: MAX_EAN_ATTEMPTS },
  };

  const rowsWhere: Prisma.StyleWhereInput = floatedActive
    ? floatedWhere
    : {
        poNumber: { not: null },
        ...scopeWhere,
        ...(statusActive ? { eanStatus: statusActive } : {}),
      };

  // Status chips show true totals for the scope being viewed (global for the
  // floated triage), so the chip numbers match the list below them.
  const countsWhere: Prisma.StyleWhereInput = floatedActive
    ? { poNumber: { not: null } }
    : { poNumber: { not: null }, ...scopeWhere };

  const [styles, activeCount, parkedCount, statusGroups, floatedCount, recycleQueue] = await Promise.all([
    db.style.findMany({
      where: rowsWhere,
      select: {
        id: true,
        name: true,
        rawData: true,
        poNumber: true,
        eanStatus: true,
        eanAttempts: true,
        cartonEan: true,
        poFileName: true,
        eanResolvedAt: true,
        poSeq: true,
        supplier: { select: { name: true } },
        eans: {
          orderBy: { position: "asc" },
          select: { id: true, size: true, ean13: true, variantLabel: true, cartonEan: true, excluded: true, manual: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: activeFilter ? FILTERED_TAKE : 200,
    }),
    minPo === null
      ? Promise.resolve(0)
      : db.style.count({ where: { poNumber: { not: null }, poSeq: { gte: minPo } } }),
    minPo === null
      ? Promise.resolve(0)
      : db.style.count({
          where: { poNumber: { not: null }, OR: [{ poSeq: { lt: minPo } }, { poSeq: null }] },
        }),
    // True per-status totals across the scope (not just the loaded window).
    db.style.groupBy({ by: ["eanStatus"], where: countsWhere, _count: { _all: true } }),
    db.style.count({ where: floatedWhere }),
    // The recycle queue in service order (least-recently-checked first), so a
    // row's position gives it an honest "next check" estimate. Only in-scope
    // (at/above the PO cutoff) rows are ever recycled — parked ones are not in
    // this list and are labelled as such instead of being promised a re-check.
    db.style.findMany({
      where: {
        ...floatedWhere,
        ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
      },
      select: { id: true },
      orderBy: { eanResolvedAt: "asc" },
      take: RECYCLE_QUEUE_SCAN,
    }),
  ]);

  // id → how many rows the cycle serves before it. Rows past the scan window
  // fall back to the window size, which errs toward a LATER estimate.
  const recycleRank = new Map(recycleQueue.map((r, i) => [r.id, i]));
  const now = new Date();

  const rows: PoEanRow[] = styles.map((s) => {
    const lane = eanLane({
      status: s.eanStatus,
      attempts: s.eanAttempts,
      poSeq: s.poSeq,
      cutoff: minPo,
      lastCheckedAt: s.eanResolvedAt,
      aheadInQueue: recycleRank.get(s.id) ?? RECYCLE_QUEUE_SCAN,
      now,
    });
    return {
      id: s.id,
      name: s.name,
      colourCode: readColourCode(s.rawData),
      poNumber: s.poNumber ?? "",
      supplierName: s.supplier?.name ?? null,
      resolvedAt: s.eanResolvedAt ? formatDate(s.eanResolvedAt) : null,
      eanAttempts: s.eanAttempts,
      lane:
        lane.kind === "cycling"
          ? {
              kind: "cycling" as const,
              // "due now" reads truthfully for a row the cycle just hasn't
              // reached yet; a future date is a real estimate.
              nextCheck:
                lane.nextCheckAt.getTime() <= now.getTime()
                  ? "due now"
                  : formatDate(lane.nextCheckAt),
            }
          : lane.kind === "parked"
            ? { kind: "parked" as const, cutoff: minPo ?? 0 }
            : { kind: "active" as const },
      initial: {
        status: s.eanStatus,
        poFileName: s.poFileName,
        cartonEan: s.cartonEan,
        sizeEans: s.eans.map(toEanSize),
      },
    };
  });

  // True per-status totals (from the DB, within the current scope) for the chips.
  const counts: Record<string, number> = {};
  for (const g of statusGroups) counts[g.eanStatus] = g._count._all;

  const scopeQuery = viewingParked ? "scope=parked" : "";

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">PO barcodes</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Each style&rsquo;s <strong>PO number</strong> is resolved automatically: the matching{" "}
          <strong>Purchase Order PDF</strong> in the central <strong>Suppliers</strong> SharePoint
          library is parsed and the per-size/colour <strong>Barcode EAN</strong> (in size order) +{" "}
          <strong>carton EAN</strong> are stored on the style. Resolution is queued when the PO is
          filled (Monday sync); <em>PO has no barcodes</em> means the PO PDF has no EAN page yet
          (retried automatically). Use <em>Re-resolve</em> to force a fresh read.
        </p>
      </div>

      <div className="mb-6">
        <PoEanAutoRunSetting initialEnabled={autoRunEnabled} />
      </div>

      {minPo !== null && !floatedActive && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">PO cutoff ≥ {minPo}:</span>
          <a
            href="/po-eans"
            className={`rounded-full px-3 py-1 font-medium ${
              !viewingParked ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            Active <span className="tabular-nums opacity-80">{activeCount.toLocaleString()}</span>
          </a>
          <a
            href="/po-eans?scope=parked"
            className={`rounded-full px-3 py-1 font-medium ${
              viewingParked ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            Parked <span className="tabular-nums opacity-80">{parkedCount.toLocaleString()}</span>
          </a>
          {viewingParked && (
            <span className="text-xs text-zinc-400">
              below the cutoff — not auto-scraped; use Re-resolve to scrape manually
            </span>
          )}
        </div>
      )}

      <PoEansTable
        rows={rows}
        counts={counts}
        floatedCount={floatedCount}
        activeFilter={activeFilter}
        scopeQuery={scopeQuery}
      />
    </div>
  );
}

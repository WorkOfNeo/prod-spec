import Link from "next/link";
import {
  getAutoGenerateEnabled,
  getDoneGroupPoCutoff,
  getStylesTableColumns,
} from "@/lib/settings/app-settings";
import { getSessionWithRole } from "@/lib/auth-server";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { activeStylesWhere, resolveDoneCutoffIds } from "@/lib/styles/active-filter";
import { loadStyleListRows } from "@/lib/styles/list-rows";
import { loadStyleIdsWithPdfs } from "@/lib/styles/table-rollups";
import { StylesTable } from "./styles-table";
import { DonePoCutoffSetting } from "./done-po-cutoff-setting";

export const dynamic = "force-dynamic";

export const metadata = { title: "Styles" };

export default async function StylesPage() {
  const [autoGenerateEnabled, doneCutoff, visibleColumns, { role }, stylesWithPdfs] = await Promise.all([
    getAutoGenerateEnabled(),
    getDoneGroupPoCutoff(),
    getStylesTableColumns(),
    getSessionWithRole(),
    // The review-flow gate: styles with at least one generated PDF.
    loadStyleIdsWithPdfs(),
    // Output Builder layouts resolve as variants in the readiness walks
    // behind every row (loadStyleListRows).
    ensureLayoutVariantsLoaded(),
  ]);

  // Done-group exception: when the cutoff is set, Done-group styles whose
  // PO number parses ABOVE it join the list (in the MAIN view, not behind
  // "Show archived") — the review window for backfilled orders. Computed
  // once here and reused both for the query and the per-row `archived` flag.
  // See src/lib/styles/active-filter.ts for the shared predicate.
  const doneCutoffIds = await resolveDoneCutoffIds(doneCutoff);

  // Load all styles for client-side search. At ~4k rows the payload is
  // bigger than the legacy 200-row cap, but the filtering UX is instant and
  // the table only mounts the rows scrolled into view (see styles-table.tsx).
  // Switch to server-side pagination if the row count ever crosses ~20k.
  // Rows are built in src/lib/styles/list-rows.ts, which selects only the
  // columns they read and projects rawData in SQL (rawdata-projection.ts).
  const rows = await loadStyleListRows({
    // The active set — not archived/deleted, Templates/Done hidden,
    // Done-cutoff styles re-admitted. Shared with /combos via activeStylesWhere.
    //
    // includeMissingPo: this ONE surface loads the PO-less styles too. They
    // are not in the flow (nothing generates without a PO) and the table
    // hides them by default, but an operator chasing "where did my style
    // go?" has to be able to find the row — so it ships to the browser
    // behind the "No PO" chip rather than being filtered out in SQL. The
    // gate itself still lives in activeStylesWhere, for every other caller.
    where: await activeStylesWhere({ doneCutoff, doneCutoffIds, includeMissingPo: true }),
    visibleColumns,
    autoGenerateEnabled,
    stylesWithPdfs,
    doneCutoffIds,
  });

  // The headline count is the LISTED set, not the loaded set — the PO-less
  // rows ride along in the payload (see includeMissingPo above) but they are
  // not on the board yet, so counting them here would overstate the work.
  const listedCount = rows.filter((r) => !r.missingPo).length;

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Styles</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {listedCount} {listedCount === 1 ? "style" : "styles"} on file, newest PO
            first. Search across name, customer, business area, PO# and status, or pick
            values in the Customer / Business Area / Group / Status / Reviewer / EAN
            dropdowns and press Apply.
          </p>
        </div>
        <Link
          href="/styles/new"
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          + New manual style
        </Link>
      </div>

      <div className="mb-6">
        <DonePoCutoffSetting initialCutoff={doneCutoff} />
      </div>

      <StylesTable
        autoGenerateEnabled={autoGenerateEnabled}
        visibleColumns={visibleColumns}
        canConfigureColumns={role === "ADMIN"}
        isAdmin={role === "ADMIN"}
        rows={rows}
      />
    </div>
  );
}

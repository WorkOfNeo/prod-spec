import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { getAutoGenerateEnabled, getStylesTableColumns } from "@/lib/settings/app-settings";
import { getSessionWithRole } from "@/lib/auth-server";
import { computeReadiness } from "@/lib/styles/readiness";
import { computeEffectiveStatus } from "@/lib/styles/effective-status";
import { findMissingDetailFields, requiredFieldKeysFromOutputs } from "@/lib/styles/detail-fields";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import { styleReadinessNotice } from "@/lib/styles/readiness-notice";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { effectiveStyleItem } from "@/lib/styles/resolved-fields";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { isArchivedGroup } from "@/lib/import/heuristics";
import { getDoneGroupPoCutoff } from "@/lib/settings/app-settings";
import { activeStylesWhere, resolveDoneCutoffIds } from "@/lib/styles/active-filter";
import { StylesTable } from "./styles-table";
import { DonePoCutoffSetting } from "./done-po-cutoff-setting";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";

export const dynamic = "force-dynamic";

export const metadata = { title: "Styles" };

export default async function StylesPage() {
  // Output Builder layouts resolve as variants in the readiness walks below.
  await ensureLayoutVariantsLoaded();

  const [autoGenerateEnabled, doneCutoff, visibleColumns, { role }, withPdfs] = await Promise.all([
    getAutoGenerateEnabled(),
    getDoneGroupPoCutoff(),
    getStylesTableColumns(),
    getSessionWithRole(),
    // Which styles have at least one generated PDF — the gate for the
    // review-flow statuses ("Ready for review" must mean real outputs).
    // Indexed, never touches the JobAsset Bytes column.
    db.job.findMany({
      where: { status: { not: "FAILED" }, assets: { some: {} } },
      select: { styleId: true },
      distinct: ["styleId"],
    }),
  ]);
  const stylesWithPdfs = new Set(withPdfs.map((j) => j.styleId));

  // Done-group exception: when the cutoff is set, Done-group styles whose
  // PO number parses ABOVE it join the list (in the MAIN view, not behind
  // "Show archived") — the review window for backfilled orders. Computed
  // once here and reused both for the query and the per-row `archived` flag
  // below. See src/lib/styles/active-filter.ts for the shared predicate.
  const doneCutoffIds = await resolveDoneCutoffIds(doneCutoff);

  // Load all styles for client-side search. At ~4k rows the initial
  // HTML payload is bigger than the legacy 200-row cap, but the table
  // renders in <500 ms and the filtering UX is instant. Switch to
  // server-side pagination if the row count ever crosses ~20k.
  const styles = await db.style.findMany({
      // Exactly the active set — not archived/deleted, Templates/Done hidden,
      // Done-cutoff styles re-admitted. Shared with /combos via activeStylesWhere.
      where: await activeStylesWhere({ doneCutoff, doneCutoffIds }),
      include: {
        // config feeds the per-style required-field check below.
        customer: { select: { name: true, config: true } },
        businessAreaRef: { select: { name: true } },
        // Country falls back to the linked supplier's country when the mapped
        // mirror column is empty (see effectiveStyleItem).
        supplier: { select: { country: true } },
        // Threshold the completion bar is measured against + the enabled
        // outputs, whose union of required fields drives the readiness check.
        prodSpec: { select: { autoGenerateThresholdPct: true, active: true, outputs: true } },
        // Resolved PO barcodes — the ean13/cartonEan fallback source for
        // the readiness checks (see effectiveStyleItem).
        eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
        // Latest job → drives the post-generation half of the Status pill
        // (queued / generating / review states), independent of the stored
        // Style.status, which Monday re-syncs reset (see ingest.ts).
        jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
      },
      orderBy: { updatedAt: "desc" },
  });

  // Parse each customer's config once, not per style row. Yields both the
  // column mapping (required-field check) and the skipSupplierDelivery flag
  // (the "Delivers own" row indicator).
  const configByCustomer = new Map<string, ReturnType<typeof parseCustomerConfig>>();
  const configFor = (customerId: string, config: unknown) => {
    let c = configByCustomer.get(customerId);
    if (!c) {
      c = parseCustomerConfig(config);
      configByCustomer.set(customerId, c);
    }
    return c;
  };
  const mappingFor = (customerId: string, config: unknown): ColumnMapping =>
    configFor(customerId, config).columnMapping;

  // Per-style operator ignores — ignored outputs drop out of the readiness
  // counts below (they're decided, not pending work).
  const ignoredByStyle = await loadIgnoredOutputKeysByStyle(styles.map((s) => s.id));

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Styles</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {styles.length} {styles.length === 1 ? "style" : "styles"} on file. Search
            across name, customer, business area, PO# and status, or pick values in the
            Customer / Business Area / Group / Status / EAN dropdowns and press Apply.
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
        rows={styles.map((s) => {
          const ba = s.businessAreaRef?.name ?? s.businessArea ?? null;
          const requiredKeys = requiredFieldKeysFromOutputs(s.prodSpec?.outputs);
          const missingDetailFields =
            requiredKeys.length > 0
              ? findMissingDetailFields(
                  effectiveStyleItem(s),
                  mappingFor(s.customerId, s.customer.config),
                  requiredKeys,
                )
              : [];
          // Per-output readiness: each output generates as soon as its own
          // fields land. Uses the customer mapping (empty override) to match
          // mappingFor above.
          const outputReadiness = (
            s.prodSpec
              ? outputReadinessForStyle(
                  {
                    rawData: s.rawData,
                    poNumber: s.poNumber,
                    supplier: s.supplier,
                    eans: s.eans,
                    cartonEan: s.cartonEan,
                    customer: { config: s.customer.config },
                    prodSpec: { outputs: s.prodSpec.outputs, columnMapping: {} },
                  },
                  undefined,
                  undefined,
                  ignoredByStyle.get(s.id),
                )
              : []
          ).filter((o) => !o.excluded);
          const outputsReady = outputReadiness.filter((o) => o.ready).length;
          const r = computeReadiness({
            completionPct: s.completionPct,
            prodSpec: s.prodSpec
              ? {
                  autoGenerateThresholdPct: s.prodSpec.autoGenerateThresholdPct,
                  active: s.prodSpec.active,
                }
              : null,
            autoGenerateEnabled,
            missingDetailFields: missingDetailFields.map((f) => f.label),
            outputs: {
              total: outputReadiness.length,
              ready: outputsReady,
              blocking: outputReadiness
                .filter((o) => !o.ready)
                .map((o) => ({ name: o.name, missing: o.missing.map((m) => m.label) })),
            },
          });
          // The Status pill: review flow when PDFs/jobs exist, otherwise the
          // field-readiness ladder. Never the raw stored Style.status.
          // NOTE: still computed — status filtering/sorting keys off
          // statusView.key (see facetOptions/filtered in styles-table.tsx), so
          // the underlying model stays intact even though the *visible* pill
          // now shows the cause-aware readiness notice headline.
          const statusView = computeEffectiveStatus({
            readiness: r,
            hasPdfs: stylesWithPdfs.has(s.id),
            latestJobStatus: s.jobs[0]?.status ?? null,
            outputs: { ready: outputsReady, total: outputReadiness.length },
          });
          // The cause-aware readiness notice — the new visible pill. The list
          // is the LIGHT case: per-output readiness (no full generation state),
          // upgraded with hasPdfs + the newest job's status. ADMIN view.
          const notice = styleReadinessNotice(
            {
              eanStatus: s.eanStatus,
              eanAttempts: s.eanAttempts,
              poNumber: s.poNumber,
              poFileName: s.poFileName,
              hasProdSpec: Boolean(s.prodSpec),
              // outputReadinessForStyle returns one entry per *enabled* output,
              // so a non-empty list IS "spec has enabled outputs".
              prodSpecHasOutputs: outputReadiness.length > 0,
              outputReadiness,
              hasPdfs: stylesWithPdfs.has(s.id),
              latestJobStatus: s.jobs[0]?.status ?? null,
            },
            "ADMIN",
          );
          return {
            id: s.id,
            name: s.name,
            poNumber: s.poNumber,
            customerName: s.customer.name,
            // Customer delivers their own goods — surfaced as a row chip so a
            // style isn't mistaken for one the app sends supplier delivery for.
            customerDeliversOwn: configFor(s.customerId, s.customer.config).skipSupplierDelivery,
            businessArea: ba,
            completionPct: s.completionPct,
            threshold: s.prodSpec?.autoGenerateThresholdPct ?? null,
            hasProdSpec: Boolean(s.prodSpec),
            // The "Prod spec" attribute chip filters on an *applied* spec —
            // linked AND active. A linked-but-inactive spec counts as "no
            // spec" there: it won't generate (auto-enqueue is gated on active),
            // and nearly every style carries a linked spec, so the bare
            // presence check never narrowed. hasProdSpec stays "linked" for
            // the completion column's tooltip.
            prodSpecActive: Boolean(s.prodSpec?.active),
            hasSupplier: Boolean(s.supplierId),
            // How many of the fields this style's outputs need carry a value
            // (filled / total). 0 total = its outputs need nothing / none set.
            requiredTotal: requiredKeys.length,
            requiredFilled: requiredKeys.length - missingDetailFields.length,
            statusView,
            // Cause-aware readiness pill (replaces the visible statusView pill
            // in the table). statusView is kept for filtering/sorting.
            notice,
            eanStatus: s.eanStatus,
            groupTitle: s.groupTitle,
            // Soft-hidden behind "Show archived" — except Done-group styles
            // re-admitted by the PO cutoff, AND styles manually pulled in for
            // layout testing, both of which belong in the main view.
            archived:
              isArchivedGroup(s.groupTitle) &&
              !doneCutoffIds.has(s.id) &&
              s.pulledForTestAt == null,
            // Manually pulled in for layout testing (Settings ▸ Pull style by
            // PO) — shown via the "Pulled" attribute chip.
            pulledForTest: s.pulledForTestAt != null,
            lastSyncedAt: formatDate(s.lastSyncedAt),
            searchBlob: [
              s.name,
              s.customer.name,
              ba ?? "",
              s.poNumber ?? "",
              statusView.label,
              s.groupTitle ?? "",
              eanStatusMeta(s.eanStatus).label,
            ]
              .join(" ")
              .toLowerCase(),
          };
        })}
      />
    </div>
  );
}

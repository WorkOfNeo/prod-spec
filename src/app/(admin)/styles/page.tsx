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
import { effectiveStyleItem, resolveMappedField } from "@/lib/styles/resolved-fields";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { isArchivedGroup } from "@/lib/import/heuristics";
import { getDoneGroupPoCutoff } from "@/lib/settings/app-settings";
import { activeStylesWhere, resolveDoneCutoffIds } from "@/lib/styles/active-filter";
import { loadLookalikeChips } from "@/lib/styles/related";
import { StylesTable } from "./styles-table";
import { DonePoCutoffSetting } from "./done-po-cutoff-setting";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import {
  needsSupplierUploadData,
  needsReviewRollupData,
  visibleResolvedFieldKeys,
  type StyleColumnKey,
} from "@/lib/styles/table-columns";
import {
  loadSupplierUploadRollups,
  loadAssetsByStyle,
  reviewRollupFor,
} from "@/lib/styles/table-rollups";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { currentOutputBaseKeys } from "@/lib/tickets/orphan";

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
        // mirror column is empty (see effectiveStyleItem). name + sharepointUrl
        // feed the opt-in Supplier / Folder-connected columns.
        supplier: { select: { name: true, country: true, sharepointUrl: true } },
        // Threshold the completion bar is measured against + the enabled
        // outputs, whose union of required fields drives the readiness check.
        // id + name feed the opt-in "Prod spec" column (links to the spec).
        prodSpec: { select: { id: true, name: true, autoGenerateThresholdPct: true, active: true, outputs: true } },
        // Resolved PO barcodes — the ean13/cartonEan fallback source for
        // the readiness checks (see effectiveStyleItem).
        eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, cartonEan: true } },
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

  // Lookalike rows — "this style name exists on more than one PO". The wrong
  // row gets picked HERE, during search, before anything is opened, so the
  // warning has to live on the list and not only on the style page (which is
  // the backstop, src/app/(admin)/styles/[id]/related-rows-card.tsx). ONE
  // indexed query for the whole page — three scalar columns, no rawData, no
  // N+1 — so it costs essentially nothing next to the ~4k-row query above
  // that already pulls every style's full Monday snapshot. Not filtered to the
  // active set on purpose: a twin parked in a hidden Done/Templates group is
  // exactly the row a reviewer can't see and still needs warning about.
  const lookalikeChips = await loadLookalikeChips(
    styles.map((s) => ({ id: s.id, name: s.name, poNumber: s.poNumber })),
  );

  // Opt-in columns are HYDRATED only when visible, so the ~4k-row payload stays
  // small and the two batched rollup queries only run when their column is on.
  const styleIds = styles.map((s) => s.id);
  const resolvedFieldKeys = visibleResolvedFieldKeys(visibleColumns);
  const wantUpload = needsSupplierUploadData(visibleColumns);
  const wantReview = needsReviewRollupData(visibleColumns);
  const [supplierUploads, assetsByStyle] = await Promise.all([
    wantUpload ? loadSupplierUploadRollups(styleIds) : Promise.resolve(new Map<string, never>()),
    wantReview ? loadAssetsByStyle(styleIds) : Promise.resolve(new Map<string, never>()),
  ]);

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
          // The style resolved against its mapping — built once and reused for
          // both the required-field check and the opt-in spec-field columns.
          const mapping = mappingFor(s.customerId, s.customer.config);
          const effItem = effectiveStyleItem(s);
          const requiredKeys = requiredFieldKeysFromOutputs(s.prodSpec?.outputs);
          const missingDetailFields =
            requiredKeys.length > 0
              ? findMissingDetailFields(effItem, mapping, requiredKeys)
              : [];
          // Per-output readiness: each output generates as soon as its own
          // fields land. Uses the customer mapping (empty override) to match
          // mappingFor above. fullReadiness keeps excluded rows so the review
          // rollup can drop their stale assets the same way /review does.
          const fullReadiness = s.prodSpec
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
            : [];
          const outputReadiness = fullReadiness.filter((o) => !o.excluded);
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

          // ── Opt-in column data ──────────────────────────────────────────
          // Resolved spec fields (composition, colour, price, …) — only the
          // VISIBLE ones, read from the same effItem + mapping as above.
          const resolved: Record<string, string> = {};
          for (const key of resolvedFieldKeys) {
            resolved[key] = resolveMappedField(effItem, mapping, key as keyof ColumnMapping);
          }
          // Review / approval rollup (approved N/M, fully-approved, awaiting) —
          // computed from the batched assets, dropping excluded bases like
          // /review does. Null unless a review column is on.
          const review = wantReview
            ? reviewRollupFor(
                assetsByStyle.get(s.id) ?? [],
                currentOutputBaseKeys(parseProdSpecOutputs(s.prodSpec?.outputs ?? [])),
                new Set(fullReadiness.filter((o) => o.excluded).map((o) => o.variantKey.split("#")[0])),
                outputReadiness.length,
              )
            : null;

          return {
            id: s.id,
            name: s.name,
            poNumber: s.poNumber,
            customerName: s.customer.name,
            // "1 of 2 rows with this name" — null (the common case) renders
            // nothing. See loadLookalikeChips above.
            lookalike: lookalikeChips.get(s.id) ?? null,
            // ── Identity & links (always small; hydrated regardless) ──
            supplierName: s.supplier?.name ?? null,
            supplierCountry: s.supplier?.country ?? null,
            prodSpecName: s.prodSpec?.name ?? null,
            prodSpecId: s.prodSpec?.id ?? null,
            cartonEan: s.cartonEan,
            poFileName: s.poFileName,
            styleFolderUrl: s.styleFolderUrl,
            mondayItemId: s.mondayItemId,
            mondayBoardId: s.mondayBoardId,
            createdAt: formatDate(s.createdAt),
            updatedAt: formatDate(s.updatedAt),
            // ── SharePoint & delivery ──
            // Supplier has a "Supplier Folder" link on the Suppliers board.
            folderConnected: Boolean(s.supplier?.sharepointUrl?.trim()),
            // The resolved "APPROVED LAYOUTS" folder once something uploaded.
            supplierFolderUrl: s.supplierFolderUrl,
            upload: wantUpload ? (supplierUploads.get(s.id) ?? null) : null,
            // ── Spec fields (resolved) + review rollup ──
            resolved,
            review,
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
              // Opt-in columns join search too — but only the hydrated
              // (visible) ones, so hidden columns don't bloat the blob.
              s.supplier?.name ?? "",
              s.prodSpec?.name ?? "",
              ...Object.values(resolved),
            ]
              .join(" ")
              .toLowerCase(),
          };
        })}
      />
    </div>
  );
}

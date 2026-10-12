import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { computeReadiness } from "@/lib/styles/readiness";
import { computeEffectiveStatus } from "@/lib/styles/effective-status";
import { findMissingDetailFields, requiredFieldKeysFromOutputs } from "@/lib/styles/detail-fields";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import { styleReadinessNotice } from "@/lib/styles/readiness-notice";
import { effectiveStyleItem, resolveMappedField } from "@/lib/styles/resolved-fields";
import { parseCustomerConfig, type ColumnMapping, type CustomerConfig } from "@/lib/customers/config";
import { isArchivedGroup } from "@/lib/import/heuristics";
import { hasPoNumber } from "@/lib/styles/active-filter";
import { loadLookalikeChips, type LookalikeChip } from "@/lib/styles/related";
import {
  needsSupplierUploadData,
  needsReviewRollupData,
  visibleResolvedFieldKeys,
  type StyleColumnKey,
} from "@/lib/styles/table-columns";
import {
  loadSupplierUploadRollups,
  loadAssetsByStyle,
  loadReviewerByStyle,
  reviewRollupFor,
  type ReviewAsset,
  type SupplierUploadRollup,
} from "@/lib/styles/table-rollups";
import { listPathColumnIds, loadProjectedRawData } from "@/lib/styles/rawdata-projection";
import type { StyleListRow } from "@/lib/styles/table-row";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { currentOutputBaseKeys } from "@/lib/tickets/orphan";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";

// =====================================================
// The /styles list: load every listed style and build its table row. Lives
// here (not in page.tsx) so scripts/perf/parity-styles-list.ts can build the
// exact rows the page ships and compare the projected-rawData path against
// the full one.
// =====================================================

// Only the Style columns the row build reads. In particular NOT rawData (the
// whole Monday item — loaded separately, projected, see rawdata-projection.ts),
// missingFields or poScrapeSnapshot. Customer and ProdSpec are loaded once per
// id rather than joined per row: their config / outputs JSON is the same for
// thousands of styles.
export const STYLE_LIST_SELECT = {
  id: true,
  name: true,
  customerId: true,
  prodSpecId: true,
  supplierId: true,
  businessArea: true,
  poNumber: true,
  poSeq: true,
  cartonEan: true,
  completionPct: true,
  eanStatus: true,
  eanAttempts: true,
  poFileName: true,
  groupTitle: true,
  pulledForTestAt: true,
  styleFolderUrl: true,
  supplierFolderUrl: true,
  mondayItemId: true,
  mondayBoardId: true,
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
  businessAreaRef: { select: { name: true } },
  // Country falls back to the linked supplier's country when the mapped
  // mirror column is empty (see effectiveStyleItem). name + sharepointUrl
  // feed the opt-in Supplier / Folder-connected columns.
  supplier: { select: { name: true, country: true, sharepointUrl: true } },
  // Resolved PO barcodes — the ean13/cartonEan fallback source for
  // the readiness checks (see effectiveStyleItem).
  eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, cartonEan: true } },
  // Latest job → drives the post-generation half of the Status pill
  // (queued / generating / review states), independent of the stored
  // Style.status, which Monday re-syncs reset (see ingest.ts).
  jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
} satisfies Prisma.StyleSelect;

// formatDate (src/lib/utils.ts) via ONE shared formatter. toLocaleString
// builds a fresh Intl formatter on every call (~80 µs), and three dates per
// row made it the single most expensive step of building ~4k rows. Same
// locale and options — list-rows.test.ts pins the output to formatDate's.
const LIST_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export function formatListDate(d: Date | null): string {
  return d ? LIST_DATE_FORMAT.format(d) : "—";
}

export type StyleListSource = Prisma.StyleGetPayload<{ select: typeof STYLE_LIST_SELECT }> & {
  rawData: unknown;
};
export type StyleListCustomer = { name: string; config: unknown };
// Threshold the completion bar is measured against + the enabled outputs,
// whose union of required fields drives the readiness check. id + name feed
// the opt-in "Prod spec" column (links to the spec).
export type StyleListProdSpec = {
  id: string;
  name: string;
  autoGenerateThresholdPct: number;
  active: boolean;
  outputs: unknown;
};

// Everything a row needs beyond its own style: page-wide settings plus the
// batched per-style lookups (one query each for the whole page, never per row).
export type StyleListContext = {
  autoGenerateEnabled: boolean;
  // Styles with at least one generated PDF — the gate for the review-flow
  // statuses ("Ready for review" must mean real outputs).
  stylesWithPdfs: ReadonlySet<string>;
  // Done-group styles re-admitted by the PO cutoff (resolveDoneCutoffIds).
  doneCutoffIds: ReadonlySet<string>;
  resolvedFieldKeys: readonly StyleColumnKey[];
  wantUpload: boolean;
  wantReview: boolean;
  ignoredByStyle: ReadonlyMap<string, Set<string>>;
  lookalikeChips: ReadonlyMap<string, LookalikeChip>;
  reviewerByStyle: ReadonlyMap<string, string>;
  supplierUploads: ReadonlyMap<string, SupplierUploadRollup>;
  assetsByStyle: ReadonlyMap<string, ReviewAsset[]>;
  // Parses each customer's config once, not per style row. Yields both the
  // column mapping (required-field check) and the skipSupplierDelivery flag
  // (the "Delivers own" row indicator).
  configFor: (customerId: string, config: unknown) => CustomerConfig;
};

export function customerConfigCache(): (customerId: string, config: unknown) => CustomerConfig {
  const byCustomer = new Map<string, CustomerConfig>();
  return (customerId, config) => {
    let c = byCustomer.get(customerId);
    if (!c) {
      c = parseCustomerConfig(config);
      byCustomer.set(customerId, c);
    }
    return c;
  };
}

// The batched lookups behind StyleListContext. Opt-in columns are HYDRATED
// only when visible, so the ~4k-row payload stays small and the two batched
// rollup queries only run when their column is on.
export async function loadStyleListContext(
  styles: ReadonlyArray<{ id: string; name: string; poNumber: string | null }>,
  opts: {
    visibleColumns: readonly StyleColumnKey[];
    autoGenerateEnabled: boolean;
    stylesWithPdfs: ReadonlySet<string>;
    doneCutoffIds: ReadonlySet<string>;
    configFor?: StyleListContext["configFor"];
  },
): Promise<StyleListContext> {
  const styleIds = styles.map((s) => s.id);
  const wantUpload = needsSupplierUploadData(opts.visibleColumns);
  const wantReview = needsReviewRollupData(opts.visibleColumns);
  const [ignoredByStyle, lookalikeChips, supplierUploads, assetsByStyle, reviewerByStyle] =
    await Promise.all([
      // Per-style operator ignores — ignored outputs drop out of the readiness
      // counts (they're decided, not pending work).
      loadIgnoredOutputKeysByStyle(styleIds),
      // Lookalike rows — "this style name exists on more than one PO". The
      // wrong row gets picked HERE, during search, before anything is opened,
      // so the warning has to live on the list and not only on the style page
      // (the backstop, src/app/(admin)/styles/[id]/related-rows-card.tsx). ONE
      // indexed query for the whole page — three scalar columns, no rawData,
      // no N+1. Not filtered to the active set on purpose: a twin parked in a
      // hidden Done/Templates group is exactly the row a reviewer can't see
      // and still needs warning about.
      loadLookalikeChips(styles.map((s) => ({ id: s.id, name: s.name, poNumber: s.poNumber }))),
      wantUpload ? loadSupplierUploadRollups(styleIds) : Promise.resolve(new Map<string, never>()),
      wantReview ? loadAssetsByStyle(styleIds) : Promise.resolve(new Map<string, never>()),
      // Not column-gated: the "Reviewer" facet needs a value on every row to
      // build its option list, so this one always loads (one indexed query).
      loadReviewerByStyle(styleIds),
    ]);
  return {
    autoGenerateEnabled: opts.autoGenerateEnabled,
    stylesWithPdfs: opts.stylesWithPdfs,
    doneCutoffIds: opts.doneCutoffIds,
    resolvedFieldKeys: visibleResolvedFieldKeys(opts.visibleColumns),
    wantUpload,
    wantReview,
    ignoredByStyle,
    lookalikeChips,
    reviewerByStyle,
    supplierUploads,
    assetsByStyle,
    configFor: opts.configFor ?? customerConfigCache(),
  };
}

// One table row. Pure given its inputs — rawData only has to carry the
// columns rawdata-projection.ts keeps.
export function buildStyleListRow(
  s: StyleListSource,
  customer: StyleListCustomer,
  prodSpec: StyleListProdSpec | null,
  ctx: StyleListContext,
): StyleListRow {
  const ba = s.businessAreaRef?.name ?? s.businessArea ?? null;
  const config = ctx.configFor(s.customerId, customer.config);
  // The style resolved against its mapping — built once and reused for
  // both the required-field check and the opt-in spec-field columns.
  const mapping: ColumnMapping = config.columnMapping;
  const effItem = effectiveStyleItem(s);
  const requiredKeys = requiredFieldKeysFromOutputs(prodSpec?.outputs);
  const missingDetailFields =
    requiredKeys.length > 0 ? findMissingDetailFields(effItem, mapping, requiredKeys) : [];
  // Per-output readiness: each output generates as soon as its own
  // fields land. Uses the customer mapping (empty override) to match
  // the mapping above. fullReadiness keeps excluded rows so the review
  // rollup can drop their stale assets the same way /review does.
  const fullReadiness = prodSpec
    ? outputReadinessForStyle(
        {
          rawData: s.rawData,
          poNumber: s.poNumber,
          supplier: s.supplier,
          eans: s.eans,
          cartonEan: s.cartonEan,
          customer: { config: customer.config },
          prodSpec: { outputs: prodSpec.outputs, columnMapping: {} },
        },
        undefined,
        undefined,
        ctx.ignoredByStyle.get(s.id),
      )
    : [];
  const outputReadiness = fullReadiness.filter((o) => !o.excluded);
  const outputsReady = outputReadiness.filter((o) => o.ready).length;
  const r = computeReadiness({
    completionPct: s.completionPct,
    prodSpec: prodSpec
      ? {
          autoGenerateThresholdPct: prodSpec.autoGenerateThresholdPct,
          active: prodSpec.active,
        }
      : null,
    autoGenerateEnabled: ctx.autoGenerateEnabled,
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
  // NOTE: still computed — status filtering keys off statusView.key (see
  // facetOptions/filtered in styles-table.tsx), so the underlying model stays
  // intact even though the *visible* pill now shows the cause-aware readiness
  // notice headline.
  const statusView = computeEffectiveStatus({
    readiness: r,
    hasPdfs: ctx.stylesWithPdfs.has(s.id),
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
      hasProdSpec: Boolean(prodSpec),
      // outputReadinessForStyle returns one entry per *enabled* output,
      // so a non-empty list IS "spec has enabled outputs".
      prodSpecHasOutputs: outputReadiness.length > 0,
      outputReadiness,
      hasPdfs: ctx.stylesWithPdfs.has(s.id),
      latestJobStatus: s.jobs[0]?.status ?? null,
    },
    "ADMIN",
  );

  // ── Opt-in column data ──────────────────────────────────────────
  // Resolved spec fields (composition, colour, price, …) — only the
  // VISIBLE ones, read from the same effItem + mapping as above.
  const resolved: Record<string, string> = {};
  for (const key of ctx.resolvedFieldKeys) {
    resolved[key] = resolveMappedField(effItem, mapping, key as keyof ColumnMapping);
  }
  // Review / approval rollup (approved N/M, fully-approved, awaiting) —
  // computed from the batched assets, dropping excluded bases like
  // /review does. Null unless a review column is on.
  const review = ctx.wantReview
    ? reviewRollupFor(
        ctx.assetsByStyle.get(s.id) ?? [],
        currentOutputBaseKeys(parseProdSpecOutputs(prodSpec?.outputs ?? [])),
        new Set(fullReadiness.filter((o) => o.excluded).map((o) => o.variantKey.split("#")[0])),
        outputReadiness.length,
      )
    : null;

  return {
    id: s.id,
    name: s.name,
    poNumber: s.poNumber,
    // Parsed PO number — the default sort key. Never sort on the
    // poNumber string (see table-sort.ts).
    poSeq: s.poSeq,
    customerName: customer.name,
    // Who is reviewing: the claimer of the newest claimed job. Drives
    // the Reviewer facet + the (opt-in) Reviewer column.
    reviewerName: ctx.reviewerByStyle.get(s.id) ?? null,
    // "1 of 2 rows with this name" — null (the common case) renders
    // nothing. See loadLookalikeChips.
    lookalike: ctx.lookalikeChips.get(s.id) ?? null,
    // ── Identity & links (always small; hydrated regardless) ──
    supplierName: s.supplier?.name ?? null,
    supplierCountry: s.supplier?.country ?? null,
    prodSpecName: prodSpec?.name ?? null,
    prodSpecId: prodSpec?.id ?? null,
    cartonEan: s.cartonEan,
    poFileName: s.poFileName,
    styleFolderUrl: s.styleFolderUrl,
    mondayItemId: s.mondayItemId,
    mondayBoardId: s.mondayBoardId,
    createdAt: formatListDate(s.createdAt),
    updatedAt: formatListDate(s.updatedAt),
    // ── SharePoint & delivery ──
    // Supplier has a "Supplier Folder" link on the Suppliers board.
    folderConnected: Boolean(s.supplier?.sharepointUrl?.trim()),
    // The resolved "APPROVED LAYOUTS" folder once something uploaded.
    supplierFolderUrl: s.supplierFolderUrl,
    upload: ctx.wantUpload ? (ctx.supplierUploads.get(s.id) ?? null) : null,
    // ── Spec fields (resolved) + review rollup ──
    resolved,
    review,
    // Customer delivers their own goods — surfaced as a row chip so a
    // style isn't mistaken for one the app sends supplier delivery for.
    customerDeliversOwn: config.skipSupplierDelivery,
    businessArea: ba,
    completionPct: s.completionPct,
    threshold: prodSpec?.autoGenerateThresholdPct ?? null,
    hasProdSpec: Boolean(prodSpec),
    // The "Prod spec" attribute chip filters on an *applied* spec —
    // linked AND active. A linked-but-inactive spec counts as "no
    // spec" there: it won't generate (auto-enqueue is gated on active),
    // and nearly every style carries a linked spec, so the bare
    // presence check never narrowed. hasProdSpec stays "linked" for
    // the completion column's tooltip.
    prodSpecActive: Boolean(prodSpec?.active),
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
      isArchivedGroup(s.groupTitle) && !ctx.doneCutoffIds.has(s.id) && s.pulledForTestAt == null,
    // Manually pulled in for layout testing (Settings ▸ Pull style by
    // PO) — shown via the "Pulled" attribute chip.
    pulledForTest: s.pulledForTestAt != null,
    // No "Navision Task" / PO number on the Monday row yet. Loaded but
    // hidden from the default view — nothing can generate without a
    // PO, so the flow hasn't started. The "No PO" chip reveals them.
    missingPo: !hasPoNumber(s.poNumber),
    lastSyncedAt: formatListDate(s.lastSyncedAt),
    searchBlob: [
      s.name,
      customer.name,
      ba ?? "",
      s.poNumber ?? "",
      statusView.label,
      s.groupTitle ?? "",
      eanStatusMeta(s.eanStatus).label,
      // Opt-in columns join search too — but only the hydrated
      // (visible) ones, so hidden columns don't bloat the blob.
      s.supplier?.name ?? "",
      prodSpec?.name ?? "",
      ...Object.values(resolved),
    ]
      .join(" ")
      .toLowerCase(),
  };
}

// Load and build the rows for every style matching `where`, in list order.
// Four steps, the per-id ones batched and run side by side: the styles
// (selected columns only) → their customers, prod specs and the page-wide
// lookups → rawData, projected to the columns the live customer mappings
// can read (or the full item, for the parity script) → the rows.
export async function loadStyleListRows(opts: {
  where: Prisma.StyleWhereInput;
  visibleColumns: readonly StyleColumnKey[];
  autoGenerateEnabled: boolean;
  stylesWithPdfs: ReadonlySet<string>;
  doneCutoffIds: ReadonlySet<string>;
  // "projected" (the page) or "full" — the reference the parity script
  // compares the projection against.
  rawData?: "projected" | "full";
}): Promise<StyleListRow[]> {
  const styles = await db.style.findMany({
    where: opts.where,
    select: STYLE_LIST_SELECT,
    // Newest PURCHASE ORDER first — the reviewer's list opens on the work
    // that just came in. poSeq is the PARSED number (ingest.ts), never the
    // poNumber string: "C-PO9" sorts above "C-PO12345" lexicographically.
    // Styles with no parsed PO sort last (they're not on the PO timeline);
    // updatedAt breaks ties. The client re-applies the same order via
    // sortByPoDesc, which is where it's tested — this keeps the payload
    // already in that order so nothing re-flows on hydration.
    orderBy: [{ poSeq: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
  });
  const styleIds = styles.map((s) => s.id);
  const customerIds = [...new Set(styles.map((s) => s.customerId))];
  const prodSpecIds = [...new Set(styles.flatMap((s) => (s.prodSpecId ? [s.prodSpecId] : [])))];
  const configFor = customerConfigCache();

  const customersP = db.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, name: true, config: true },
  });
  // The projection needs the customers' mappings, so it chains off that
  // query instead of waiting for the whole batch below.
  const rawDataP: Promise<Map<string, unknown>> =
    opts.rawData === "full"
      ? db.style
          .findMany({ where: { id: { in: styleIds } }, select: { id: true, rawData: true } })
          .then((rows) => new Map(rows.map((r) => [r.id, r.rawData])))
      : customersP.then((customers) =>
          loadProjectedRawData(
            styleIds,
            listPathColumnIds(customers.map((c) => configFor(c.id, c.config).columnMapping)),
          ),
        );
  const [customers, prodSpecs, rawDataById, ctx] = await Promise.all([
    customersP,
    prodSpecIds.length > 0
      ? db.prodSpec.findMany({
          where: { id: { in: prodSpecIds } },
          select: { id: true, name: true, autoGenerateThresholdPct: true, active: true, outputs: true },
        })
      : Promise.resolve([]),
    rawDataP,
    loadStyleListContext(styles, { ...opts, configFor }),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const prodSpecById = new Map(prodSpecs.map((p) => [p.id, p]));

  return styles.map((s) => {
    const customer = customerById.get(s.customerId);
    // Style.customerId is a required FK, so this is a broken invariant, not
    // a state to render around.
    if (!customer) throw new Error(`Style ${s.id}: customer ${s.customerId} not found`);
    const prodSpec = s.prodSpecId ? (prodSpecById.get(s.prodSpecId) ?? null) : null;
    // has(), not ??: a JSON-null rawData is a real value. A row missing from
    // the second query (deleted in between) reads as the column default.
    const rawData = rawDataById.has(s.id) ? rawDataById.get(s.id) : {};
    return buildStyleListRow({ ...s, rawData }, customer, prodSpec, ctx);
  });
}

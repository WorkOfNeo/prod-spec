import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { computeReadiness } from "@/lib/styles/readiness";
import { findMissingDetailFields, requiredFieldKeysFromOutputs } from "@/lib/styles/detail-fields";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { effectiveStyleItem } from "@/lib/styles/resolved-fields";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { HIDDEN_STYLE_GROUP_TERMS, isArchivedGroup } from "@/lib/import/heuristics";
import { getDoneGroupPoCutoff } from "@/lib/settings/app-settings";
import { parsePoNumberValue } from "@/lib/po/po-number";
import { StylesTable } from "./styles-table";
import { DonePoCutoffSetting } from "./done-po-cutoff-setting";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const [autoGenerateEnabled, doneCutoff] = await Promise.all([
    getAutoGenerateEnabled(),
    getDoneGroupPoCutoff(),
  ]);

  // Done-group exception: when the cutoff is set, Done-group styles whose
  // PO number parses ABOVE it join the list (in the MAIN view, not behind
  // "Show archived") — the review window for backfilled orders. The PO is
  // free text ("C-PO63145"), so the numeric compare happens here, on a
  // cheap two-column scan, and the main query re-admits the ids.
  const doneCutoffIds = new Set<string>();
  if (doneCutoff !== null) {
    const candidates = await db.style.findMany({
      where: {
        archivedAt: null,
        deletedAt: null,
        groupTitle: { contains: "done", mode: "insensitive" },
        poNumber: { not: null },
      },
      select: { id: true, poNumber: true },
    });
    for (const c of candidates) {
      if ((parsePoNumberValue(c.poNumber) ?? -1) > doneCutoff) doneCutoffIds.add(c.id);
    }
  }

  // Load all styles for client-side search. At ~4k rows the initial
  // HTML payload is bigger than the legacy 200-row cap, but the table
  // renders in <500 ms and the filtering UX is instant. Switch to
  // server-side pagination if the row count ever crosses ~20k.
  const styles = await db.style.findMany({
      // Hard-exclude the "Templates" + "Done" groups — except Done styles
      // re-admitted by the PO cutoff above. A null group is kept (matches
      // neither term). See HIDDEN_STYLE_GROUP_TERMS.
      where: {
        // Archived / deleted Monday items are retained for the audit log but
        // hidden here (soft lifecycle stamped by the webhook).
        archivedAt: null,
        deletedAt: null,
        OR: [
          {
            NOT: HIDDEN_STYLE_GROUP_TERMS.map((term) => ({
              groupTitle: { contains: term, mode: "insensitive" as const },
            })),
          },
          ...(doneCutoffIds.size > 0 ? [{ id: { in: [...doneCutoffIds] } }] : []),
        ],
      },
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
      },
      orderBy: { updatedAt: "desc" },
  });

  // Parse each customer's column mapping once, not per style row.
  const mappingByCustomer = new Map<string, ColumnMapping>();
  const mappingFor = (customerId: string, config: unknown): ColumnMapping => {
    let m = mappingByCustomer.get(customerId);
    if (!m) {
      m = parseCustomerConfig(config).columnMapping;
      mappingByCustomer.set(customerId, m);
    }
    return m;
  };

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Styles</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {styles.length} {styles.length === 1 ? "style" : "styles"} on file. Search
            across name, customer, business area, PO# and status, or use the filter
            chips (click to cycle: has → missing).
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
          const outputReadiness = s.prodSpec
            ? outputReadinessForStyle({
                rawData: s.rawData,
                poNumber: s.poNumber,
                supplier: s.supplier,
                customer: { config: s.customer.config },
                prodSpec: { outputs: s.prodSpec.outputs, columnMapping: {} },
              })
            : [];
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
              ready: outputReadiness.filter((o) => o.ready).length,
              blocking: outputReadiness
                .filter((o) => !o.ready)
                .map((o) => ({ name: o.name, missing: o.missing.map((m) => m.label) })),
            },
          });
          return {
            id: s.id,
            name: s.name,
            poNumber: s.poNumber,
            customerName: s.customer.name,
            businessArea: ba,
            completionPct: s.completionPct,
            threshold: s.prodSpec?.autoGenerateThresholdPct ?? null,
            hasProdSpec: Boolean(s.prodSpec),
            hasSupplier: Boolean(s.supplierId),
            // How many of the fields this style's outputs need carry a value
            // (filled / total). 0 total = its outputs need nothing / none set.
            requiredTotal: requiredKeys.length,
            requiredFilled: requiredKeys.length - missingDetailFields.length,
            readiness: { tone: r.tone, label: r.shortLabel, hint: r.title },
            status: s.status,
            eanStatus: s.eanStatus,
            groupTitle: s.groupTitle,
            // Soft-hidden behind "Show archived" — except Done-group styles
            // re-admitted by the PO cutoff, which belong in the main view.
            archived: isArchivedGroup(s.groupTitle) && !doneCutoffIds.has(s.id),
            lastSyncedAt: formatDate(s.lastSyncedAt),
            searchBlob: [
              s.name,
              s.customer.name,
              ba ?? "",
              s.poNumber ?? "",
              s.status,
              s.status.toLowerCase().replace(/_/g, " "),
              s.groupTitle ?? "",
              r.shortLabel,
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

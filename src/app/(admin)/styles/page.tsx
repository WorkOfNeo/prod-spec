import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { computeReadiness } from "@/lib/styles/readiness";
import { findMissingDetailFields, requiredFieldKeysFromOutputs } from "@/lib/styles/detail-fields";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { effectiveStyleItem } from "@/lib/styles/resolved-fields";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { HIDDEN_STYLE_GROUP_TERMS } from "@/lib/import/heuristics";
import { StylesTable } from "./styles-table";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  // Load all styles for client-side search. At ~4k rows the initial
  // HTML payload is bigger than the legacy 200-row cap, but the table
  // renders in <500 ms and the filtering UX is instant. Switch to
  // server-side pagination if the row count ever crosses ~20k.
  const [styles, autoGenerateEnabled] = await Promise.all([
    db.style.findMany({
      // Hard-exclude the "Templates" (Pre-Order stubs) and "Done" groups —
      // these never belong on the list, not even behind "Show archived".
      // A null group is kept (matches neither term). See HIDDEN_STYLE_GROUP_TERMS.
      where: {
        // Archived / deleted Monday items are retained for the audit log but
        // hidden here (soft lifecycle stamped by the webhook).
        archivedAt: null,
        deletedAt: null,
        NOT: HIDDEN_STYLE_GROUP_TERMS.map((term) => ({
          groupTitle: { contains: term, mode: "insensitive" as const },
        })),
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
    }),
    getAutoGenerateEnabled(),
  ]);

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

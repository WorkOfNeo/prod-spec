// Diagnostic panel below the Edit form: shows what is ACTUALLY stored
// on the Style — identity, FKs, group, and the resolved column mapping
// (semantic field → Monday column id → value). Lets the operator spot
// "composition is empty because po.text64__1 wasn't enriched" without
// having to crack open the DB.

import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { isArchivedGroup } from "@/lib/import/heuristics";

type RawColumn = { id?: unknown; text?: unknown };

// Each ColumnMapping key in order of label-importance for the operator.
// Edit the array to reorder / hide diagnostic fields without touching
// the runtime mapping itself.
const FIELDS: Array<{ key: keyof ColumnMapping; label: string }> = [
  { key: "composition", label: "Composition" },
  { key: "sizes", label: "Sizes" },
  { key: "washCare", label: "Wash care" },
  { key: "ean13", label: "EAN per size" },
  { key: "colourCode", label: "Colour code" },
  { key: "colourName", label: "Colour name" },
  { key: "poNumber", label: "PO number" },
  { key: "countryOfOrigin", label: "Country of origin" },
  { key: "lot", label: "Lot" },
  { key: "cartonQty", label: "Carton qty" },
  { key: "cartonEan", label: "Carton EAN" },
  { key: "klNumber", label: "KL number" },
  { key: "supplierNumber", label: "Supplier number" },
  { key: "supplierEmail", label: "Supplier email" },
  { key: "productNameTranslations", label: "Product name translations" },
  { key: "styleNumber", label: "Style number" },
  { key: "businessArea", label: "Business area (text)" },
  { key: "price", label: "Price" },
];

export function SavedDataPanel({
  style,
  customer,
}: {
  style: {
    id: string;
    name: string;
    mondayItemId: string;
    mondayBoardId: string;
    groupId: string | null;
    groupTitle: string | null;
    poNumber: string | null;
    businessArea: string | null;
    completionPct: number;
    status: string;
    rawData: unknown;
  };
  customer: { id: string; name: string; slug: string; config: unknown };
}) {
  const cfg = parseCustomerConfig(customer.config);
  const mapping = cfg.columnMapping;

  const columnValues = ((style.rawData as { column_values?: unknown } | null)?.column_values ??
    []) as RawColumn[];
  const allIds = new Set(columnValues.map((cv) => String(cv.id ?? "")).filter(Boolean));
  const findText = (id: string | undefined): string | null => {
    if (!id) return null;
    const hit = columnValues.find((cv) => cv.id === id);
    if (!hit) return null;
    return typeof hit.text === "string" ? hit.text : null;
  };

  const archived = isArchivedGroup(style.groupTitle);
  const poStyleColumns = columnValues
    .map((cv) => (typeof cv.id === "string" && cv.id.startsWith("po.") ? cv.id : null))
    .filter((x): x is string => x !== null);

  return (
    <section className="mt-10 rounded-lg border border-zinc-200 bg-white">
      <header className="border-b border-zinc-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-zinc-700">Saved data</h2>
        <p className="text-xs text-zinc-500">
          Snapshot of what the PDF renderers will see for this Style. Empty values are why a
          field shows blank on the printed label — fix at the source (Monday column, ProdSpec
          mapping, or Pre-Order enrichment).
        </p>
      </header>

      {/* Identity + status */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-zinc-100 px-5 py-4 text-xs sm:grid-cols-3">
        <Pair label="Style name" value={style.name} />
        <Pair label="Status" value={style.status.toLowerCase().replace(/_/g, " ")} />
        <Pair
          label="Completion"
          value={`${style.completionPct}%`}
          warn={style.completionPct < 100}
        />
        <Pair
          label="Group"
          value={style.groupTitle ?? "—"}
          warn={archived}
          warnHint="Archived — hidden by default on the list"
        />
        <Pair label="PO #" value={style.poNumber ?? "—"} warn={!style.poNumber} />
        <Pair label="Monday item id" value={style.mondayItemId} mono />
        <Pair label="Monday board id" value={style.mondayBoardId} mono />
        <Pair label="Customer" value={`${customer.name} · ${customer.slug}`} />
        <Pair
          label="Pre-Order columns merged"
          value={
            poStyleColumns.length === 0
              ? "none"
              : `${poStyleColumns.length} (${poStyleColumns.join(", ")})`
          }
          warn={poStyleColumns.length === 0}
          warnHint="Pre-Order enrichment hasn't landed for this PO"
        />
      </div>

      {/* Mapped fields */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 text-left uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-5 py-2">Field</th>
              <th className="px-5 py-2">Monday column id</th>
              <th className="px-5 py-2">Value</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(({ key, label }) => {
              const columnId = (mapping as Partial<Record<keyof ColumnMapping, string>>)[key];
              const value = findText(columnId);
              const empty = value === null || value === "";
              const columnMissing = columnId && !allIds.has(columnId);
              return (
                <tr key={key} className="border-t border-zinc-100">
                  <td className="px-5 py-1.5 font-medium text-zinc-800">{label}</td>
                  <td className="px-5 py-1.5 font-mono text-zinc-500">
                    {columnId ? (
                      <span title={columnMissing ? "Column id not present in rawData" : undefined}>
                        {columnId}
                        {columnMissing && (
                          <span className="ml-1 text-amber-600">· not in rawData</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-zinc-400">— (unmapped)</span>
                    )}
                  </td>
                  <td className={`px-5 py-1.5 ${empty ? "text-amber-700" : "text-zinc-900"}`}>
                    {empty ? "(empty)" : value}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="border-t border-zinc-100 bg-zinc-50 px-5 py-2 text-[11px] text-zinc-500">
        <strong>{columnValues.length}</strong> total columns in rawData. Mapping defaults from
        <code className="ml-1 font-mono">DEFAULT_COLUMN_MAPPING</code> merged with this
        customer&apos;s overrides — edit at{" "}
        <a className="underline" href={`/customers/${customer.id}`}>
          /customers/{customer.id}
        </a>
        .
      </footer>
    </section>
  );
}

function Pair({
  label,
  value,
  mono,
  warn,
  warnHint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  warn?: boolean;
  warnHint?: string;
}) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div
        className={`mt-0.5 ${mono ? "font-mono" : ""} ${
          warn ? "text-amber-700" : "text-zinc-900"
        }`}
        title={warn ? warnHint : undefined}
      >
        {value}
      </div>
    </div>
  );
}

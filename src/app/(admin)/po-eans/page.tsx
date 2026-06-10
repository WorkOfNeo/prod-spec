import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { getPoEanAutoRunEnabled } from "@/lib/settings/app-settings";
import { PoEansTable, type PoEanRow } from "./po-eans-table";
import { PoEanAutoRunSetting } from "./po-ean-auto-run-setting";

export const dynamic = "force-dynamic";

// PO → EAN resolution. Every style that carries a PO number is shown with its
// persisted resolution state: resolution is queued automatically when the PO
// is filled (Monday sync) and drained by the EAN runner, which scrapes the
// matching Purchase Order PDF from the central Suppliers SharePoint library
// and stores the per-size/colour Barcode EAN (in size order) + the carton EAN
// on the style. "Re-resolve" forces a fresh read.
export default async function PoEansPage() {
  const autoRunEnabled = await getPoEanAutoRunEnabled();
  const styles = await db.style.findMany({
    where: { poNumber: { not: null } },
    select: {
      id: true,
      name: true,
      poNumber: true,
      eanStatus: true,
      cartonEan: true,
      poFileName: true,
      eanResolvedAt: true,
      supplier: { select: { name: true } },
      eans: {
        orderBy: { position: "asc" },
        select: { size: true, ean13: true, variantLabel: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const rows: PoEanRow[] = styles.map((s) => ({
    id: s.id,
    name: s.name,
    poNumber: s.poNumber ?? "",
    supplierName: s.supplier?.name ?? null,
    resolvedAt: s.eanResolvedAt ? formatDate(s.eanResolvedAt) : null,
    initial: {
      status: s.eanStatus,
      poFileName: s.poFileName,
      cartonEan: s.cartonEan,
      sizeEans: s.eans.map((e) => ({
        size: e.size,
        ean13: e.ean13,
        variantLabel: e.variantLabel,
      })),
    },
  }));

  // Roll up the persisted statuses into summary chips above the table.
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.initial.status] = (acc[r.initial.status] ?? 0) + 1;
    return acc;
  }, {});

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

      <PoEansTable rows={rows} counts={counts} />
    </div>
  );
}

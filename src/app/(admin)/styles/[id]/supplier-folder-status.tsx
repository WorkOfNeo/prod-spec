import type { ReactNode } from "react";

// Supplier-folder push readiness for the Details panel. Shows WHERE in the
// resolution chain a style stands, so a reviewer can confirm (or spot the gap)
// before approved outputs are pushed to the supplier's SharePoint folder:
//
//   Pre-Order board · "Supplier"   →   Suppliers board · "Supplier Folder"
//        (Style.supplier)                  (Supplier.sharepointUrl)
//
// The push reads Supplier.sharepointUrl off the supplier linked on the
// Pre-Order board — so a miss is either "no supplier linked" (step 1) or
// "supplier has no folder link" (step 2). Pure server render; no Graph call
// (the stored link is what the push resolves; surfacing it lets the reviewer
// click through to confirm the actual destination).
export function SupplierFolderStatus({
  supplierName,
  folderUrl,
}: {
  supplierName: string | null; // null ⇒ no supplier linked on the Pre-Order board
  folderUrl: string | null; // null ⇒ supplier has no folder link on the Suppliers board
}) {
  const hasSupplier = supplierName != null;
  const hasLink = folderUrl != null;
  const ready = hasSupplier && hasLink;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700">Supplier folder</h2>
        <span className="text-xs text-zinc-400">
          Where approved outputs are pushed — resolved through the Monday chain.
        </span>
      </div>
      <div
        className={`mt-2 overflow-hidden rounded-lg border ${
          ready ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/50"
        }`}
      >
        <ol className="divide-y divide-zinc-100">
          <ChainStep
            ok={hasSupplier}
            label="Supplier linked"
            source="Pre-Order board · “Supplier” column"
            value={hasSupplier ? supplierName : "Not linked"}
          />
          <ChainStep
            ok={hasLink}
            label="Supplier Folder link"
            source="Suppliers board · “Supplier Folder” column"
            value={
              hasLink ? (
                <a
                  href={folderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-zinc-950"
                >
                  Open folder ↗
                </a>
              ) : (
                "Not set"
              )
            }
          />
        </ol>
        <div
          className={`border-t px-4 py-2.5 text-xs ${
            ready ? "border-emerald-100 text-emerald-800" : "border-amber-100 text-amber-800"
          }`}
        >
          {ready ? (
            <>
              ✓ Ready — pushes land in <span className="font-medium">{supplierName}</span>’s folder,
              in a “&lt;PO&gt; - &lt;customer&gt; - &lt;supplier&gt;” folder → “APPROVED LAYOUTS”
              subfolder (shared across styles on the same PO).
            </>
          ) : !hasSupplier ? (
            <>
              ⚠ No supplier is linked to this style on the <span className="font-medium">Pre-Order
              board</span> (“Supplier” column). Link one there and re-sync — the folder link is read
              from that supplier’s row on the Monday Suppliers board.
            </>
          ) : (
            <>
              ⚠ Supplier <span className="font-medium">{supplierName}</span> is linked, but has no
              Supplier Folder link on the <span className="font-medium">Monday Suppliers board</span>{" "}
              (“Supplier Folder” column). Set it there and re-sync.
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ChainStep({
  ok,
  label,
  source,
  value,
}: {
  ok: boolean;
  label: string;
  source: string;
  value: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span
        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          ok ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
        }`}
        aria-hidden
      >
        {ok ? "✓" : "!"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-800">{label}</div>
        <div className="text-[11px] text-zinc-400">{source}</div>
      </div>
      <div className={`text-right text-sm ${ok ? "text-zinc-800" : "text-amber-700"}`}>{value}</div>
    </li>
  );
}

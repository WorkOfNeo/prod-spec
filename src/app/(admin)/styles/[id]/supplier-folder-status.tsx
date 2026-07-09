import type { ReactNode } from "react";
import { SupplierFolderFileCount } from "./supplier-folder-file-count";

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
// Roll-up of this style's supplier-send queue rows — the ACTUAL push outcome
// (vs. the readiness chain above). Fed from SupplierSendQueueItem.
export type PoFolderDelivery = {
  uploaded: number;
  noFolder: number; // PO folder not found — app won't create it
  ambiguous: number; // several folders match the PO
  other: number; // PENDING/FAILED/SKIPPED (in-flight / gap)
  total: number;
  folderUrl: string | null; // the PO / APPROVED LAYOUTS folder link when uploaded
  // The competing folders when ambiguous — reviewer opens each and deletes the
  // extra so exactly one PO folder remains.
  ambiguousMatches: Array<{ name: string; webUrl: string | null }>;
};

export function SupplierFolderStatus({
  styleId,
  supplierName,
  folderUrl,
  poNumber,
  delivery,
  className = "mt-8",
}: {
  styleId: string;
  supplierName: string | null; // null ⇒ no supplier linked on the Pre-Order board
  folderUrl: string | null; // null ⇒ supplier has no folder link on the Suppliers board
  poNumber: string | null; // the PO whose folder we count files in
  delivery?: PoFolderDelivery | null; // null/absent ⇒ nothing queued for this style
  // Root <section> classes — the caller controls spacing (defaults to a
  // standalone top margin; "" when placed in the above-tabs grid column).
  className?: string;
}) {
  const hasSupplier = supplierName != null;
  const hasLink = folderUrl != null;
  const ready = hasSupplier && hasLink;
  const hasPo = poNumber != null && poNumber.trim() !== "";

  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-zinc-700">Supplier folder</h2>
          {/* Live file count for the PO folder — fetched lazily (Graph). Only
              worth asking once there's a supplier folder link and a PO. */}
          {ready && hasPo && <SupplierFolderFileCount styleId={styleId} />}
        </div>
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

      {delivery && delivery.total > 0 ? <PoFolderState delivery={delivery} /> : null}
    </section>
  );
}

// The PO-folder push outcome for this style. The app SEARCHES the supplier's
// folder for the PO folder and never creates it — so "no PO folder" is a real,
// actionable state (create it upstream), not a transient error.
function PoFolderState({ delivery }: { delivery: PoFolderDelivery }) {
  const { uploaded, noFolder, ambiguous, total, folderUrl, ambiguousMatches } = delivery;
  // Worst-first tone: ambiguous > missing > partial > done > queued.
  const tone =
    ambiguous > 0
      ? "border-fuchsia-200 bg-fuchsia-50/60 text-fuchsia-800"
      : noFolder > 0
        ? "border-orange-200 bg-orange-50/60 text-orange-800"
        : uploaded > 0
          ? "border-emerald-200 bg-emerald-50/50 text-emerald-800"
          : "border-zinc-200 bg-zinc-50 text-zinc-600";

  return (
    <div className={`mt-2 rounded-lg border px-4 py-2.5 text-xs ${tone}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-zinc-700">SharePoint delivery</span>
        {folderUrl ? (
          <a href={folderUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-950">
            Open PO folder ↗
          </a>
        ) : null}
      </div>
      {ambiguous > 0 ? (
        <>
          ⚠ <span className="font-medium">Multiple folders match this PO</span> in the supplier’s SharePoint — there must
          be exactly one. Open each and delete the extra; it uploads on the next sweep.
          {ambiguousMatches.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {ambiguousMatches.map((m, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span aria-hidden>•</span>
                  {m.webUrl ? (
                    <a href={m.webUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-950">
                      {m.name} ↗
                    </a>
                  ) : (
                    <span>{m.name}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : noFolder > 0 ? (
        <>
          ⚠ {noFolder} of {total} output(s) can’t upload — <span className="font-medium">no PO folder found</span> in the
          supplier’s SharePoint. The app never creates it; create the PO folder there and they upload on the next sweep.
        </>
      ) : uploaded >= total ? (
        <>✓ All {total} approved output(s) are in the PO folder’s “APPROVED LAYOUTS” subfolder.</>
      ) : uploaded > 0 ? (
        <>
          {uploaded} of {total} output(s) uploaded to the PO folder; the rest are queued for the next sweep.
        </>
      ) : (
        <>Queued — {total} approved output(s) will upload to the PO folder on the next sweep.</>
      )}
    </div>
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

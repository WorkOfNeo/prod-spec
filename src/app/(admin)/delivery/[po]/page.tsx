import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { db } from "@/lib/db";
import { PoDeliveryPanel } from "./po-delivery-panel";

export const dynamic = "force-dynamic";

// The per-PO ledger. The heavy work (folder resolution, listing, the expected
// set for every style on the PO) happens in the client panel's fetch, not here:
// it costs several sequential Graph round-trips and blocking the server render
// on SharePoint would make the page feel broken whenever Graph is slow. The
// server half only resolves WHICH folder we mean.
export default async function PoDeliveryPage({
  params,
  searchParams,
}: {
  params: Promise<{ po: string }>;
  searchParams: Promise<{ supplier?: string }>;
}) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/");

  const { po } = await params;
  const poNumber = decodeURIComponent(po);
  const { supplier } = await searchParams;

  // A PO number can in principle appear under two suppliers (two different
  // orders that happen to share a reference), and they are DIFFERENT folders.
  // The list always links with ?supplier=; arriving without one, resolve it —
  // and if it is genuinely ambiguous, ask rather than guess.
  const suppliers = await db.style.findMany({
    where: { poNumber, supplierId: { not: null }, archivedAt: null, deletedAt: null },
    select: { supplierId: true, supplier: { select: { name: true } } },
    distinct: ["supplierId"],
  });

  if (suppliers.length === 0) {
    return (
      <Shell poNumber={poNumber}>
        <p className="text-sm text-zinc-600">
          No live style on this PO has a supplier, so there is no folder to check.
        </p>
      </Shell>
    );
  }

  const supplierId =
    supplier && suppliers.some((s) => s.supplierId === supplier) ? supplier : suppliers.length === 1 ? suppliers[0].supplierId : null;

  if (!supplierId) {
    return (
      <Shell poNumber={poNumber}>
        <p className="text-sm text-zinc-600">
          This PO number appears under {suppliers.length} suppliers, and each has its own folder. Pick one:
        </p>
        <ul className="mt-3 space-y-1 text-sm">
          {suppliers.map((s) => (
            <li key={s.supplierId}>
              <Link
                href={`/delivery/${encodeURIComponent(poNumber)}?supplier=${s.supplierId}`}
                className="underline hover:text-zinc-950"
              >
                {s.supplier?.name ?? s.supplierId}
              </Link>
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  return (
    <Shell poNumber={poNumber}>
      <PoDeliveryPanel poNumber={poNumber} supplierId={supplierId as string} />
    </Shell>
  );
}

function Shell({ poNumber, children }: { poNumber: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href="/delivery" className="text-sm text-zinc-500 underline hover:text-zinc-800">
        ← All purchase orders
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{poNumber}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Every approved document for this PO, checked against the supplier&apos;s APPROVED LAYOUTS folder.
      </p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

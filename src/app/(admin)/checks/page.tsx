import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { ChecksPanel } from "./checks-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checks" };

// =====================================================
// Checks — the self-service audit surface.
//
// Every other folder screen in the app answers "did what we owe the supplier
// arrive?" and treats the folder as evidence. This one asks the mirror
// question: "is there anything in that folder that should not be there, or is
// there under the wrong name?" It starts from what is FOUND rather than from
// what is expected, which is why it is its own page and not a tab on
// /delivery — the same data, read from the other end, produces different rows
// and a different remedy.
//
// It sits in the reviewer nav rather than under Settings deliberately. This is
// not configuration: it is a question a reviewer asks about an order they are
// working on, and burying it two clicks into an admin menu is how a check stops
// being run. It gates on canReview, like /delivery and /reviews.
//
// The page itself is a shell. Every finding costs several sequential Graph
// round-trips, so the work happens in the panel's fetch — blocking the server
// render on SharePoint would make the page feel broken whenever Graph is slow.
// =====================================================

export default async function ChecksPage({
  searchParams,
}: {
  searchParams: Promise<{ po?: string; supplier?: string }>;
}) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  // Hiding the nav link is not access control — the page enforces the role
  // itself, and so does every endpoint behind it.
  if (!canReview(role)) redirect("/");

  const sp = await searchParams;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Checks</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Audit a purchase order&apos;s supplier folder against what the app believes should be in it. The folder
        belongs to the PO and is shared by every style on it, so both checks below resolve the whole order
        before they judge a single file.
      </p>
      <div className="mt-6">
        <ChecksPanel initialPo={sp.po ?? ""} initialSupplier={sp.supplier ?? null} />
      </div>
    </div>
  );
}

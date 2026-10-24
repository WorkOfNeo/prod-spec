import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview, isAdmin } from "@/lib/roles";
import { formatDate } from "@/lib/utils";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { listChangeRequests } from "@/lib/change-requests/requests";
import { RequestStatusSchema } from "@/lib/change-requests/types";
import { RequestsInbox, type InboxRow } from "./requests-inbox";
import { outputSignals, signalTotals } from "@/lib/change-requests/signals";
import { SignalsTable } from "@/components/change-requests/signals-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Requests" };

// =====================================================
// /requests — the change-request inbox (design docs/plans/change-requests.md §6).
//
// "This print output is wrong", filed with text and screenshots per output.
// Admins see every request and work them; a REVIEWER files their own and sees
// only those (the scoping is listChangeRequests', not this page's). The page
// gates like /checks: canReview, enforced here and again by every endpoint.
//
// Behind CHANGE_REQUESTS_ENABLED: with the flag off the page does not exist.
// =====================================================

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  if (!changeRequestsEnabled()) notFound();
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/");

  const sp = await searchParams;
  const parsed = RequestStatusSchema.safeParse(sp.status);
  const status = parsed.success ? parsed.data : null;
  const admin = isAdmin(role);

  const rows = await listChangeRequests({ viewer: { userId: session.user.id, role }, status: status ?? undefined });
  // Learning signals (drafts per request, first-try approval, cost) are an
  // admin read; reviewers only see their own requests.
  const signalRows = admin ? await outputSignals() : [];
  // Dates are formatted here, on the server, so the client never re-formats
  // them in another time zone during hydration.
  const view: InboxRow[] = rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    title: r.title,
    status: r.status,
    poNumber: r.poNumber,
    outputs: r.outputs.map((o) => ({ id: o.id, label: o.label, status: o.status })),
    requester: r.createdById === session.user.id ? "You" : (r.createdByEmail ?? "—"),
    createdLabel: formatDate(r.createdAt),
  }));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            {admin
              ? "Reports that a print output is wrong, one issue per output. The assistant drafts each change on a copy; nothing prints differently until you approve it."
              : "Your reports that a print output is wrong. An admin approves every change before anything prints differently."}
          </p>
        </div>
        <Link
          href="/requests/new"
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New request
        </Link>
      </div>
      <div className="mt-6">
        <RequestsInbox rows={view} status={status} showRequester={admin} />
      </div>
      {admin && signalRows.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold tracking-tight">Learning signals</h2>
          <p className="mt-1 text-sm text-zinc-500">
            How often the assistant&apos;s first draft is approved, how many drafts it takes, and what each request cost.
          </p>
          <div className="mt-3">
            <SignalsTable rows={signalRows} totals={signalTotals(signalRows)} />
          </div>
        </section>
      )}
    </div>
  );
}

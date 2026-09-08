import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { SweepPanel } from "./sweep-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checks — every PO" };

// =====================================================
// The same folder audit /checks runs on one purchase order, across the whole
// book — and grouped by FAULT rather than by folder.
//
// That grouping is the reason this page exists. Per PO, "one cover is under its
// old name" is a footnote. Across 300 orders, "142 covers are under their old
// name, all of them renameable" is a piece of work someone can plan, and the
// four judgement calls hiding among them are findable. A list of 300 folders
// each with a number next to it would answer neither question.
//
// The page never repairs anything. Every row links to that PO's own check,
// where the folder is re-read live and each file is confirmed by name before
// anything is touched — see apply-actions.ts. A sweep's findings are hours old
// by the time they are read, so that re-check is not a nicety here; it is the
// only thing that makes acting on a scan safe at all.
//
// A shell, like /checks: the work is an hour of Graph calls in the background,
// and the panel polls for it.
// =====================================================

export default async function ChecksSweepPage() {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  // Hiding a nav link is not access control — the endpoint gates too.
  if (!canReview(role)) redirect("/");

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Checks — every purchase order</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            Runs the folder check on every PO in scope and collects what it finds in one place, grouped by
            what is actually wrong. It takes about an hour, runs in the background, and can be left and
            come back to. Repairs still happen on each PO&apos;s own check, where the folder is re-read
            live first.
          </p>
        </div>
        <Link
          href="/checks"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          Check one PO
        </Link>
      </div>
      <div className="mt-6">
        <SweepPanel />
      </div>
    </div>
  );
}

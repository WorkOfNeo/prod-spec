import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { RerunButton } from "./rerun-button";

export const dynamic = "force-dynamic";

export default async function StyleDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const style = await db.style.findUnique({
    where: { id },
    include: {
      customer: true,
      jobs: {
        include: { assets: true, reviewActions: { include: { user: true } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });
  if (!style) notFound();

  const latestJob = style.jobs[0];
  const missing = (style.missingFields as Array<{ id: string; label: string }>) ?? [];

  return (
    <div className="px-8 py-8">
      <Link href="/styles" className="text-xs text-zinc-500 underline">
        ← All styles
      </Link>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{style.name}</h1>
          <p className="text-sm text-zinc-500">
            {style.customer.name} · {style.businessArea ?? "—"} · Monday {style.mondayItemId}
          </p>
        </div>
        <div className="flex gap-2">
          {latestJob?.status === "AWAITING_REVIEW" && (
            <Link
              href={`/styles/${style.id}/review`}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Review
            </Link>
          )}
          <RerunButton styleId={style.id} disabled={latestJob?.status === "RUNNING" || latestJob?.status === "QUEUED"} />
        </div>
      </div>

      <section className="mt-6 grid grid-cols-3 gap-6">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Completion</div>
          <div className="mt-2 text-2xl font-semibold">{style.completionPct}%</div>
          {missing.length > 0 && (
            <ul className="mt-2 text-xs text-zinc-600">
              {missing.slice(0, 5).map((m) => (
                <li key={m.id}>· {m.label}</li>
              ))}
              {missing.length > 5 && <li>… and {missing.length - 5} more</li>}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Status</div>
          <div className="mt-2 text-lg">{style.status.toLowerCase().replace(/_/g, " ")}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Last synced</div>
          <div className="mt-2 text-sm text-zinc-700">{formatDate(style.lastSyncedAt)}</div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-700">Jobs</h2>
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Assets</th>
                <th className="px-4 py-2">Reviewer</th>
                <th className="px-4 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {style.jobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No jobs yet.
                  </td>
                </tr>
              ) : (
                style.jobs.map((j) => (
                  <tr key={j.id} className="border-t border-zinc-100">
                    <td className="px-4 py-2">{j.status}</td>
                    <td className="px-4 py-2 text-zinc-600">{j.triggerSource}</td>
                    <td className="px-4 py-2">{j.assets.length}</td>
                    <td className="px-4 py-2 text-zinc-600">
                      {j.reviewActions[0]?.user.email ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-zinc-500">{formatDate(j.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

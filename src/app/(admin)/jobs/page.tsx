import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { RunNowButton } from "./run-now-button";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

const LEVEL_STYLES: Record<string, string> = {
  DEBUG: "text-zinc-500",
  INFO: "text-zinc-700",
  WARN: "text-amber-700",
  ERROR: "text-red-700",
};

export default async function JobsPage() {
  await requireAdminPage();

  const [jobs, recentLogs] = await Promise.all([
    db.job.findMany({
      include: { style: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.log.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  return (
    <div className="px-8 py-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 text-sm text-zinc-500">Generation runs and webhook ingestion log.</p>
        </div>
        <RunNowButton />
      </div>

      <section className="mt-6 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Job runs ({jobs.length})
        </header>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Style</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Trigger</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                  No jobs yet.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr key={j.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-medium">{j.style.name}</td>
                  <td className="px-4 py-2">{j.status}</td>
                  <td className="px-4 py-2 text-zinc-600">{j.triggerSource}</td>
                  <td className="px-4 py-2 text-zinc-500">{formatDate(j.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-8 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Recent log entries ({recentLogs.length})
        </header>
        <ul className="divide-y divide-zinc-100 font-mono text-xs">
          {recentLogs.length === 0 ? (
            <li className="px-4 py-8 text-center text-zinc-500">No log entries yet.</li>
          ) : (
            recentLogs.map((log) => (
              <li key={log.id} className="px-4 py-2">
                <div className="flex gap-3">
                  <span className="w-36 shrink-0 text-zinc-500">{formatDate(log.createdAt)}</span>
                  <span className={`w-12 shrink-0 ${LEVEL_STYLES[log.level] ?? ""}`}>{log.level}</span>
                  <span className="flex-1 text-zinc-700">{log.message}</span>
                </div>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

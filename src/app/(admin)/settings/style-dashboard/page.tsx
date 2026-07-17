import { requireAdminPage } from "@/lib/auth-server";
import {
  getGenerationQueue,
  getGenerationThroughput,
  getStyleDashboardRows,
} from "@/lib/dashboard/style-dashboard";
import { StyleDashboardClient } from "./style-dashboard-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Style dashboard" };

// Admin-only control tower for output generation, style-centric. The top band
// (live queue + throughput + Run All) polls itself; the style list below is
// filtered/searched client-side and lazy-renders, each style expanding to its
// per-output SharePoint + supplier-delivery state.
export default async function StyleDashboardPage() {
  await requireAdminPage();

  const [queue, throughput, rows] = await Promise.all([
    getGenerationQueue(),
    getGenerationThroughput(),
    getStyleDashboardRows(),
  ]);

  return (
    <div className="px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Style dashboard</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Live view of output generation — what&rsquo;s in the queue and for how long, how much has
          been generated and sent over time, and every generated output with its SharePoint and
          supplier-email state.
        </p>
      </div>

      <StyleDashboardClient initialQueue={queue} initialThroughput={throughput} rows={rows} />
    </div>
  );
}

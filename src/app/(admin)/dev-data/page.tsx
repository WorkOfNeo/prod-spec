import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth-server";
import { devDataLoaderEnabled, devDataSyncMinutes } from "@/lib/dev-data/flags";
import { DevDataPanel } from "./dev-data-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dev data" };

// =====================================================
// /dev-data — load production purchase orders into the development database.
//
// Lists the POs that came into production most recently; pick some and load
// them, and they stay in sync from then on (see src/lib/dev-data). Production
// is only read; everything lands in this environment's own database.
//
// Only exists where DEV_DATA_LOADER=true (the Railway `development`
// environment). Production never sets it, so there the page 404s.
// =====================================================

export default async function DevDataPage() {
  if (!devDataLoaderEnabled()) notFound();
  await requireAdminPage();
  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dev data</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Load purchase orders from production into this development environment. Production is only read; everything
        lands in this environment&apos;s own database. Loaded POs keep syncing every {devDataSyncMinutes()} minutes: changes
        made in production come through, and your own changes here stay until production changes the same thing.
      </p>
      <DevDataPanel />
    </div>
  );
}

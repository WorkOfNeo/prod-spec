import Link from "next/link";
import { db } from "@/lib/db";
import { InfoAreaList } from "./info-area-list";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function InfoAreaSizesPage() {
  await requireAdminPage();

  // Resilient: the info_area_sizes table ships with this feature's migration
  // (npm run db:deploy). Until it's applied, show the empty state + a hint
  // rather than crashing the settings area.
  let sizes: Array<{ id: string; name: string; widthMm: number; heightMm: number; active: boolean }> = [];
  let migrationPending = false;
  try {
    sizes = await db.infoAreaSize.findMany({
      orderBy: [{ active: "desc" }, { widthMm: "asc" }, { heightMm: "asc" }, { name: "asc" }],
      select: { id: true, name: true, widthMm: true, heightMm: true, active: true },
    });
  } catch {
    migrationPending = true;
  }

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Info area sizes</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Named print sizes for <strong>info area</strong> outputs — the direct-print packaging
          blocks built in the{" "}
          <Link href="/output-builder" className="underline">
            Output builder
          </Link>{" "}
          and flagged <em>Info area</em>. On a style&rsquo;s info-area output you pick one of these
          (or a one-time custom size) and the label prints at those dimensions. Disable a size to
          retire it without losing styles that already use it.
        </p>
      </div>

      {migrationPending ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-medium">The info-area sizes table isn&rsquo;t available yet.</p>
          <p className="mt-1 text-xs">
            Run <code className="rounded bg-amber-100 px-1 py-0.5 font-mono">npm run db:deploy</code>{" "}
            to apply the migration, then reload this page.
          </p>
        </div>
      ) : (
        <InfoAreaList initialSizes={sizes} />
      )}
    </div>
  );
}

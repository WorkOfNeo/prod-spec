// Import dashboard.
//
// Renders three sections from one ghost-data scan:
//   1. New combinations — (Customer × BusinessArea) pairs with no ProdSpec
//      yet. One-click Accept creates the ProdSpec AND promotes every
//      unambiguous matching ghost item to a Style.
//   2. Manual Import — Ready — ghost items whose pair already has a
//      ProdSpec, no ambiguity, no existing Style row. Bulk select + import.
//   3. Manual Import — Needs disambiguation — same shape as (2) but the
//      customer-name token matches several Customer rows; operator picks
//      per row before importing.
//
// Streaming: the page shell renders instantly. Each section is its own
// <Suspense> boundary so its skeleton paints with the shell. They all
// share one request-scoped scan via React's cache(), so the underlying
// SQL only runs once even with multiple suspended children awaiting it.

import Link from "next/link";
import { Suspense } from "react";
import { requireAdminPage } from "@/lib/auth-server";
import { scanForImport } from "@/lib/import/scan";
import { findUnconfiguredProdSpecs } from "@/lib/import/prod-specs";
import { CombinationsTable } from "./combinations-table";
import { ManualImportTables } from "./manual-import-tables";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requireAdminPage();
  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Promote items from the Monday Styles board into Style rows. New
          (customer × business area) combinations surface here for one-click acceptance.
          Pre-Order data is not pulled here — it&apos;s a separate enrichment flow that
          cross-links PO info into existing Styles.
        </p>
      </div>

      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>

      <section className="mb-10">
        <Suspense fallback={<SectionSkeleton title="New combinations" />}>
          <NewCombinationsSection />
        </Suspense>
      </section>

      <section className="mb-10">
        <Suspense fallback={<SectionSkeleton title="ProdSpecs needing configuration" />}>
          <NeedsConfigSection />
        </Suspense>
      </section>

      <Suspense fallback={<ManualImportSkeleton />}>
        <ManualImportSection />
      </Suspense>
    </div>
  );
}

// -----------------------------------------------------
// Async server components — each awaits the cached scan independently.
// -----------------------------------------------------

async function Stats() {
  const [scan, unconfigured] = await Promise.all([
    scanForImport(),
    findUnconfiguredProdSpecs(),
  ]);
  const s = scan.stats;
  return (
    <div className="mb-8 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Scanned ghost items" value={s.scannedItems} />
        <Stat label="Already promoted" value={s.alreadyPromoted} tone="muted" />
        <Stat label="New combinations" value={s.newCombinations} tone="primary" />
        <Stat label="Needs config" value={unconfigured.length} tone="primary" />
        <Stat label="Ready to import" value={s.importable} tone="primary" />
      </div>
      <details className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm">
        <summary className="cursor-pointer select-none text-zinc-600">
          Funnel — where the other {Math.max(0, s.scannedItems - s.alreadyPromoted - s.importable - s.ambiguous - s.contributedToCombination)} items
          went
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Customer not recognised"
            value={s.droppedUnmatchedCustomer}
            tone="muted"
            hint="Item name's leading token doesn't match any Customer's first word. Either set the customerLink env var or rename customers / items to match."
          />
          <Stat
            label="BA blank"
            value={s.droppedBlankBa}
            tone="muted"
            hint="Business Area column is empty on the Monday item."
          />
          <Stat
            label="BA value not in catalog"
            value={s.droppedUnknownBa}
            tone="muted"
            hint="Business Area text on the item doesn't match any BusinessArea row. Add the BA in /business-areas first."
          />
          <Stat
            label="Needs disambiguation"
            value={s.ambiguous}
            tone="muted"
            hint="Customer-token matched multiple Customer rows (e.g. JYSK A/S vs JYSK SE)."
          />
        </div>
      </details>
    </div>
  );
}

async function NewCombinationsSection() {
  const scan = await scanForImport();
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        New combinations ({scan.newCombinations.length})
      </h2>
      <CombinationsTable combinations={scan.newCombinations} />
    </>
  );
}

async function NeedsConfigSection() {
  const rows = await findUnconfiguredProdSpecs();
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        ProdSpecs needing configuration ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
          Every active ProdSpec has at least one enabled output. Nothing to set up.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Business area</th>
                <th className="px-4 py-3 text-right">Styles waiting</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium">{p.customerName}</td>
                  <td className="px-4 py-3 text-zinc-600">{p.businessAreaName}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600">
                    {p.styleCount}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/prod-specs/${p.id}`}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                    >
                      Configure →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function ManualImportSection() {
  const scan = await scanForImport();
  return <ManualImportTables importable={scan.importable} ambiguous={scan.ambiguous} />;
}

// -----------------------------------------------------
// Skeletons — match the shape of the real sections so layout doesn't
// shift when content streams in.
// -----------------------------------------------------

function StatsSkeleton() {
  return (
    <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[68px] animate-pulse rounded-lg border border-zinc-200 bg-zinc-50"
        />
      ))}
    </div>
  );
}

function SectionSkeleton({ title }: { title: string }) {
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h2>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-zinc-100" />
          ))}
        </div>
      </div>
    </>
  );
}

function ManualImportSkeleton() {
  return (
    <>
      <section className="mb-10">
        <SectionSkeleton title="Manual import — Ready" />
      </section>
      <section className="mb-10">
        <SectionSkeleton title="Manual import — Needs disambiguation" />
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: number;
  tone?: "default" | "primary" | "muted";
  hint?: string;
}) {
  const toneClass =
    tone === "primary"
      ? "border-zinc-900 bg-zinc-900 text-white"
      : tone === "muted"
        ? "border-zinc-200 bg-zinc-50 text-zinc-500"
        : "border-zinc-200 bg-white text-zinc-900";
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${toneClass}`}
      title={hint}
    >
      <div className="text-xs uppercase tracking-wide opacity-75">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

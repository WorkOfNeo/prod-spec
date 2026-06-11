// ProdSpec suggestions wizard. Walks the operator through:
//   1. BusinessAreas seen in the ghost data but not yet in the BA table
//   2. (Customer × BA) pairs scored by ghost-data matching
//
// One card at a time. Skip / Add (BA) / Create (ProdSpec). All state
// lives on the client; the only server work is the initial scan in
// computeSuggestions().

import Link from "next/link";
import { computeSuggestions } from "@/lib/prod-spec/suggestions";
import { SuggestionsWizard } from "./wizard";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function SuggestionsPage() {
  await requireAdminPage();

  const suggestions = await computeSuggestions();

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <Link href="/prod-specs" className="text-xs text-zinc-500 underline">
        ← Prod specs
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Suggestions wizard</h1>
        <p className="mt-1 text-sm text-zinc-500">
          We scanned {suggestions.stats.scannedItems.toLocaleString("en-GB")} items across the Styles
          and Pre Order ghost boards. Step through suggested business areas first, then
          (Customer&nbsp;×&nbsp;Business&nbsp;Area) prod-spec pairs. Skip or accept each.
        </p>
      </div>

      <section className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Customers" value={suggestions.stats.customers} />
        <Stat label="Business areas" value={suggestions.stats.businessAreas} />
        <Stat label="Existing prod specs" value={suggestions.stats.existingProdSpecs} />
        <Stat label="Items scanned" value={suggestions.stats.scannedItems} />
      </section>

      <SuggestionsWizard
        newBusinessAreas={suggestions.newBusinessAreas}
        newProdSpecs={suggestions.newProdSpecs}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {value.toLocaleString("en-GB")}
      </div>
    </div>
  );
}

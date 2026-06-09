import Link from "next/link";
import { db } from "@/lib/db";
import { WashSymbolList } from "./wash-symbol-list";
import { listActiveLanguages } from "@/lib/languages/active";

export const dynamic = "force-dynamic";

export default async function WashSymbolsPage() {
  const [symbols, languages] = await Promise.all([
    db.washSymbol.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] }),
    listActiveLanguages(),
  ]);

  // The dialog renders one input per active Language. Adding a row to
  // /languages adds a column here automatically; the order matches the
  // sortOrder set in the Language table. We pass both `code` (the JSON
  // key for the translations map) and `name` (what humans see).
  const knownLanguages = languages;

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Wash-care symbols</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Global catalogue used by the Washcare template. Each symbol has a stable{" "}
            <code className="font-mono">code</code>, a display name, an SVG file, and an optional{" "}
            <code className="font-mono">mondayValue</code> for linking to whatever string
            Monday&rsquo;s wash-care column emits. Each symbol is also classified by laundering{" "}
            <strong>action</strong> and whether it&rsquo;s a <strong>prohibition</strong> — a
            prohibition removes matching lines under{" "}
            <Link href="/settings/care-labels" className="underline">
              Care labels
            </Link>
            , where the per-line text and rules live.
          </p>
        </div>
      </div>

      <WashSymbolList
        initialSymbols={symbols.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          svg: s.svg,
          mondayValue: s.mondayValue,
          active: s.active,
          action: s.action,
          restrictive: s.restrictive,
          translations: (s.translations as Record<string, string>) ?? {},
        }))}
        knownLanguages={knownLanguages}
      />
    </div>
  );
}

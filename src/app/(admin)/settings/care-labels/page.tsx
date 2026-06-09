import Link from "next/link";
import { db } from "@/lib/db";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { toSymbolCodeArray } from "@/lib/care-labels";
import { listActiveLanguages } from "@/lib/languages/active";
import { CareLabelList } from "./care-label-list";

export const dynamic = "force-dynamic";

export default async function CareLabelsPage() {
  const [careLabels, symbols, languages] = await Promise.all([
    db.careLabel.findMany({
      orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    db.washSymbol.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      select: { code: true, name: true, action: true, restrictive: true },
    }),
    listActiveLanguages(),
  ]);

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Care labels</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          The care-instruction lines printed on Care Label 02. Add as many as you need — print order
          follows the order below. Tag each line with a laundering <strong>action</strong> and it is
          automatically removed when the style carries a matching &ldquo;Do not …&rdquo; symbol (a
          prohibition), configured under{" "}
          <Link href="/settings/washcare-symbols" className="underline">
            Wash-care symbols
          </Link>
          . Split combined lines into one per action so only the conflicting part drops. Per-line
          show/hide-by-symbol rules remain as an advanced override. Per-language text is resolved
          from the{" "}
          <Link href="/translations" className="underline">
            Translations
          </Link>{" "}
          dictionary (board <code className="font-mono">{MONDAY_BOARDS.translations}</code>) using the
          English line as the key — add the phrase there for multilingual output.
        </p>
      </div>

      <CareLabelList
        symbols={symbols}
        languages={languages}
        initialLabels={careLabels.map((l) => ({
          id: l.id,
          sourceText: l.sourceText,
          sortOrder: l.sortOrder,
          action: l.action,
          showIfSymbols: toSymbolCodeArray(l.showIfSymbols),
          hideIfSymbols: toSymbolCodeArray(l.hideIfSymbols),
          active: l.active,
        }))}
      />
    </div>
  );
}

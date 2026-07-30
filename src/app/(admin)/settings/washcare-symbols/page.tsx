import Link from "next/link";
import { db } from "@/lib/db";
import { WashSymbolList } from "./wash-symbol-list";
import { listActiveLanguages } from "@/lib/languages/active";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { DEFAULT_COLUMN_MAPPING } from "@/lib/customers/config";
import { normalizeWashToken } from "@/lib/pdf/washcare-symbols";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

// Coverage check against the Pre-Order board's wash-care dropdown (ghost
// mirror): which option labels resolve to NO catalogue symbol (they'd carry
// no action — no care-line suppression — and print a dashed placeholder
// tile), and which active symbols still lack artwork. Resolution mirrors
// the renderer: exact code/mondayValue first, then the normalised form
// (trailing dots, "℃" vs "°C", whitespace).
async function washCoverage(symbols: Array<{ code: string; mondayValue: string | null; svg: string | null; active: boolean }>) {
  const washColumnId = DEFAULT_COLUMN_MAPPING.washCare;
  if (!washColumnId) return { unmappedLabels: [] as string[], missingArtwork: [] as string[], optionCount: 0 };

  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: MONDAY_BOARDS.preOrder },
    select: { id: true },
  });
  const column = board
    ? await db.mondayGhostColumn.findUnique({
        where: { boardId_mondayColumnId: { boardId: board.id, mondayColumnId: washColumnId } },
        select: { id: true },
      })
    : null;
  const options = column
    ? await db.mondayGhostDropdownOption.findMany({
        where: { boardColumnId: column.id },
        select: { label: true },
        orderBy: { label: "asc" },
      })
    : [];

  const known = new Set<string>();
  for (const s of symbols) {
    if (!s.active) continue;
    known.add(s.code);
    known.add(normalizeWashToken(s.code));
    if (s.mondayValue) {
      known.add(s.mondayValue);
      known.add(normalizeWashToken(s.mondayValue));
    }
  }
  const unmappedLabels = options
    .map((o) => o.label)
    .filter((label) => !known.has(label) && !known.has(normalizeWashToken(label)));
  const missingArtwork = symbols
    .filter((s) => s.active && !(s.svg ?? "").trim())
    .map((s) => s.code);
  return { unmappedLabels, missingArtwork, optionCount: options.length };
}

export const metadata = { title: "Washcare symbols" };

export default async function WashSymbolsPage() {
  await requireAdminPage();

  const [symbols, languages] = await Promise.all([
    db.washSymbol.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] }),
    listActiveLanguages(),
  ]);
  const coverage = await washCoverage(symbols);

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
        unmappedLabels={coverage.unmappedLabels}
        optionCount={coverage.optionCount}
        missingArtwork={coverage.missingArtwork}
      />
    </div>
  );
}

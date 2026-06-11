import Link from "next/link";
import { db } from "@/lib/db";
import { parseProdSpecLanguages } from "@/lib/prod-spec/config";
import { listActiveLanguages } from "@/lib/languages/active";
import { ProdSpecLanguageMatrix, type MatrixRow } from "./prod-spec-language-matrix";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function ProdSpecLanguagesPage() {
  await requireAdminPage();

  const [prodSpecs, languages] = await Promise.all([
    db.prodSpec.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        customer: { select: { name: true } },
        businessArea: { select: { name: true } },
      },
    }),
    listActiveLanguages(),
  ]);

  const rows: MatrixRow[] = prodSpecs.map((ps) => ({
    id: ps.id,
    name: ps.name,
    customerName: ps.customer.name,
    businessAreaName: ps.businessArea.name,
    outputLanguages: safeParse(() => parseProdSpecLanguages(ps.outputLanguages), []),
  }));

  return (
    <div className="px-8 py-8">
      <Link href="/prod-specs" className="text-xs text-zinc-500 underline">
        ← All prod specs
      </Link>
      <div className="mb-6 mt-2">
        <h1 className="text-2xl font-semibold tracking-tight">Output languages</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Toggle which languages each prod spec&apos;s custom outputs render in. The
          per-language text is pulled from the synced Translation board; a prod spec
          with no languages selected falls back to the template&apos;s built-in default
          set. Manage the language list at <code className="font-mono">/languages</code>.
        </p>
      </div>

      {languages.length === 0 ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          No active languages — visit <code className="font-mono">/languages</code> and click{" "}
          <strong>Seed standard set</strong> to populate the matrix.
        </p>
      ) : (
        <ProdSpecLanguageMatrix rows={rows} languages={languages} />
      )}
    </div>
  );
}

function safeParse<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

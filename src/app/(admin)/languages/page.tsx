import { db } from "@/lib/db";
import { LanguageList } from "./language-list";

export const dynamic = "force-dynamic";

export default async function LanguagesPage() {
  const rows = await db.language.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Languages</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          The translation namespace for every multilingual field in the system. Wash care symbol
          translations, country name translations, and ProdSpec care instructions all key by{" "}
          <code className="font-mono">Language.code</code>. Add a language here to make it appear as
          an editable column wherever translations are entered.
        </p>
      </div>

      <LanguageList
        initialLanguages={rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          nativeName: r.nativeName,
          sortOrder: r.sortOrder,
          active: r.active,
        }))}
      />
    </div>
  );
}

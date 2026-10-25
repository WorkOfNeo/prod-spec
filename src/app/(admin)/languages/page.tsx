import { db } from "@/lib/db";
import { LanguageList } from "./language-list";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Languages" };

export default async function LanguagesPage() {
  await requireAdminPage();

  const rows = await db.language.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <div className="px-6 py-5">
      <div className="mb-6">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Languages</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
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

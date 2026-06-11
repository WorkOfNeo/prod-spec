import { db } from "@/lib/db";
import { CountryList } from "./country-list";
import { listActiveLanguages } from "@/lib/languages/active";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function CountriesPage() {
  await requireAdminPage();

  const [rows, languages] = await Promise.all([
    db.country.findMany({ orderBy: [{ active: "desc" }, { nameEn: "asc" }] }),
    listActiveLanguages(),
  ]);

  // Language slots come from /languages now, not from each country's
  // own languageCode. Single source of truth. Pass full {code, name}
  // so the editor shows the human-readable name, not just the code.
  const availableLanguages = languages;

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Countries</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Translation namespace for the rest of the app. Each row is one country with its primary
          language code and its name translated into every other language. Wash care symbols,
          ProdSpec care instructions, and the future <code className="font-mono">Style.countryOfOrigin</code>{" "}
          field all look up translations using <code className="font-mono">languageCode</code> as the key.
        </p>
      </div>

      <CountryList
        initialCountries={rows.map((r) => ({
          id: r.id,
          code: r.code,
          nameEn: r.nameEn,
          languageCode: r.languageCode,
          nameTranslations: (r.nameTranslations as Record<string, string>) ?? {},
          active: r.active,
          mondayValue: r.mondayValue,
        }))}
        availableLanguages={availableLanguages}
      />
    </div>
  );
}

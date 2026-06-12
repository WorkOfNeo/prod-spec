import { db } from "@/lib/db";
import { DEFAULT_DOC_TYPES, type DocTypeEntry } from "./doc-types";

// =====================================================
// Doc-type catalogue loader (SERVER-ONLY — imports db).
//
// Reads the UI-managed doc_types table. Resilient by design: pages that
// existed long before the catalogue (styles list, prod-spec editor,
// output builder) must keep working when the table isn't reachable yet
// — migration not applied, or a stale client — so any error degrades to
// the seed list rather than crashing the caller. Same pattern as
// ensureLayoutVariantsLoaded.
// =====================================================

let warnedUnavailable = false;

export async function loadDocTypes(): Promise<DocTypeEntry[]> {
  try {
    const rows = await db.docTypeDef.findMany({
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      select: { value: true, label: true },
    });
    // Empty table = freshly truncated/never seeded — fall back so type
    // selects are never empty (the seed values are also what the coded
    // template variants carry).
    return rows.length > 0 ? rows : DEFAULT_DOC_TYPES;
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        `[doc-types] could not load the catalogue (is the doc_types migration applied? npm run db:deploy): ${(err as Error).message}`,
      );
    }
    return DEFAULT_DOC_TYPES;
  }
}

export async function loadDocTypeLabels(): Promise<Record<string, string>> {
  const types = await loadDocTypes();
  return Object.fromEntries(types.map((t) => [t.value, t.label]));
}

export type DocTypeWithUsage = DocTypeEntry & {
  usage: {
    layouts: number; // Output Builder layouts typed with the value
    assets: number; // generated JobAssets carrying it
    templates: number; // legacy coded-template rows
    builtinVariants: boolean; // a CODED registry variant uses it (code-pinned)
  };
};

// Catalogue + usage counts — drives the management card and its delete
// guard (shared with the /api/admin/doc-types GET route so the two can
// never disagree). `codeValues` are the docTypes carried by coded
// template variants; passed in to keep this module registry-agnostic.
export async function loadDocTypesWithUsage(codeValues: Set<string>): Promise<DocTypeWithUsage[]> {
  const types = await loadDocTypes();
  try {
    const [layoutCounts, assetCounts, templateCounts] = await Promise.all([
      db.outputLayout.groupBy({ by: ["docType"], _count: { _all: true } }),
      db.jobAsset.groupBy({ by: ["docType"], _count: { _all: true } }),
      db.template.groupBy({ by: ["docType"], _count: { _all: true } }),
    ]);
    const count = (rows: Array<{ docType: string; _count: { _all: number } }>, v: string) =>
      rows.find((r) => r.docType === v)?._count._all ?? 0;
    return types.map((t) => ({
      ...t,
      usage: {
        layouts: count(layoutCounts, t.value),
        assets: count(assetCounts, t.value),
        templates: count(templateCounts, t.value),
        builtinVariants: codeValues.has(t.value),
      },
    }));
  } catch {
    // Counts are advisory (the DELETE route re-checks) — degrade to zeros.
    return types.map((t) => ({
      ...t,
      usage: { layouts: 0, assets: 0, templates: 0, builtinVariants: codeValues.has(t.value) },
    }));
  }
}

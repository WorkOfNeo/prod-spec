import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  parseBundlePageSettings,
  parseProdSpecColumnMapping,
  parseProdSpecLanguages,
  parseProdSpecOutputs,
  parseProdSpecRequiredFields,
} from "@/lib/prod-spec/config";
import { allVariants } from "@/lib/pdf/template-registry";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { formatDate } from "@/lib/utils";
import { listActiveLanguages } from "@/lib/languages/active";
import { loadCareLabels } from "@/lib/care-labels";
import { toLaunderingAction } from "@/lib/care-labels/actions";
import {
  loadTranslationDictionary,
  normaliseTranslationKey,
} from "@/lib/translations/lookup";
import { ProdSpecEditor } from "./prod-spec-editor";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function ProdSpecDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAdminPage();
  // Published Output Builder layouts join the variant catalogue below.
  await ensureLayoutVariantsLoaded();

  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const prodSpec = await db.prodSpec.findUnique({
    where: { id },
    include: {
      customer: true,
      businessArea: true,
      suppliers: { select: { id: true } },
    },
  });
  if (!prodSpec) notFound();

  const [languages, careLabels, washSymbolRows, dict, docTypeLabels] = await Promise.all([
    listActiveLanguages(),
    loadCareLabels(),
    db.washSymbol.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      select: { code: true, name: true, action: true, restrictive: true },
    }),
    loadTranslationDictionary(),
    loadDocTypeLabels(),
  ]);

  // Per care label: its Translation-board entry ({ lang → text }) so the
  // "generated from standard" panel can compose lines + flag coverage gaps
  // client-side without re-querying.
  const careTranslationsByLabel = Object.fromEntries(
    careLabels.map((label) => [
      label.id,
      dict.get(normaliseTranslationKey(label.sourceText))?.translations ?? {},
    ]),
  );

  // Defensive parse — if stored JSON is malformed for any reason, fall back
  // to empty defaults so the editor still renders.
  const outputs = safeParse(() => parseProdSpecOutputs(prodSpec.outputs), []);
  const careInstructionsByLang = parseLangMap(prodSpec.careInstructionsByLang);
  const outputLanguages = safeParse(() => parseProdSpecLanguages(prodSpec.outputLanguages), []);

  // Column mapping / required fields / suppliers left the editor (they're
  // managed at Customer level and via the supplier-link flow) — but the DB
  // values still apply at render time, so hidden overrides surface as
  // read-only notice chips instead of silent state.
  const hasColumnMappingOverride =
    Object.keys(safeParse(() => parseProdSpecColumnMapping(prodSpec.columnMapping), {})).length > 0;
  const hasRequiredFieldsOverride =
    safeParse(() => parseProdSpecRequiredFields(prodSpec.requiredFields), []).length > 0;

  return (
    <div className="px-8 py-8">
      <Link href="/prod-specs" className="text-xs text-zinc-500 underline">
        ← All prod specs
      </Link>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{prodSpec.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {prodSpec.customer.name} · {prodSpec.businessArea.name} · updated{" "}
            {formatDate(prodSpec.updatedAt)}
          </p>
        </div>
      </div>

      <ProdSpecEditor
        prodSpecId={prodSpec.id}
        initialTab={tab === "outputs" ? "outputs" : tab === "cover" ? "cover" : "general"}
        initialName={prodSpec.name}
        initialActive={prodSpec.active}
        initialThreshold={prodSpec.autoGenerateThresholdPct}
        initialOutputs={outputs}
        initialLogoSvg={prodSpec.logoSvg}
        initialGeneralInfoMd={prodSpec.generalInfoMd ?? ""}
        initialBundlePageSettings={parseBundlePageSettings(prodSpec.bundlePageSettings)}
        initialCareInstructionsByLang={careInstructionsByLang}
        initialOutputLanguages={outputLanguages}
        availableLanguages={languages}
        hasColumnMappingOverride={hasColumnMappingOverride}
        hasRequiredFieldsOverride={hasRequiredFieldsOverride}
        attachedSupplierCount={prodSpec.suppliers.length}
        variantCatalogue={allVariants().map((v) => ({
          key: v.key,
          docType: v.docType,
          docTypeLabel: docTypeLabel(v.docType, docTypeLabels),
          name: v.name,
          description: v.description,
          defaultWidthMm: v.defaultWidthMm,
          defaultHeightMm: v.defaultHeightMm,
        }))}
        careLabels={careLabels.map((l) => ({
          id: l.id,
          sourceText: l.sourceText,
          sortOrder: l.sortOrder,
          action: l.action,
          showIfSymbols: l.showIfSymbols,
          hideIfSymbols: l.hideIfSymbols,
        }))}
        washSymbols={washSymbolRows.map((s) => ({
          code: s.code,
          name: s.name,
          action: toLaunderingAction(s.action),
          restrictive: s.restrictive,
        }))}
        careTranslationsByLabel={careTranslationsByLabel}
      />
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

// Defensive coercion for the careInstructionsByLang JSON column.
// Bad shapes (arrays, primitives, non-string values) get dropped quietly.
function parseLangMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

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
import type { AwaitingApprovalStyle } from "./approve-styles-panel";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prodSpec = await db.prodSpec.findUnique({ where: { id }, select: { name: true } });
  return { title: prodSpec ? `${prodSpec.name} · Prod spec` : "Prod spec" };
}

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

  const [languages, careLabels, washSymbolRows, dict, docTypeLabels, testStyles, awaitingApproval] =
    await Promise.all([
      listActiveLanguages(),
      loadCareLabels(),
      db.washSymbol.findMany({
        where: { active: true },
        orderBy: { code: "asc" },
        select: { code: true, name: true, action: true, restrictive: true },
      }),
      loadTranslationDictionary(),
      loadDocTypeLabels(),
      // Styles linked to this prod spec — the Test tab's style picker. Most
      // recent first; archived/deleted hidden to match the rest of the app.
      db.style.findMany({
        where: { prodSpecId: id, deletedAt: null, archivedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true, poNumber: true, status: true, completionPct: true },
        take: 500,
      }),
      loadAwaitingApproval(id),
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
        styles={testStyles}
        initialTab={
          tab === "outputs"
            ? "outputs"
            : tab === "cover"
              ? "cover"
              : tab === "test"
                ? "test"
                : "general"
        }
        initialName={prodSpec.name}
        initialActive={prodSpec.active}
        initialFullyApproved={prodSpec.fullyApproved}
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
        awaitingApproval={awaitingApproval}
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

// Styles under this prod spec whose LATEST job is AWAITING_REVIEW — the
// retroactive-approval candidates surfaced in the "Styles awaiting approval"
// card. We fetch each live style's newest job (with a pending/total asset
// count) and keep only those still awaiting review; a newer QUEUED/RUNNING/
// APPROVED job means there's nothing to retroactively approve.
async function loadAwaitingApproval(prodSpecId: string): Promise<AwaitingApprovalStyle[]> {
  const styles = await db.style.findMany({
    where: {
      prodSpecId,
      deletedAt: null,
      archivedAt: null,
      // Cheap pre-filter so we only inspect styles that have at least one
      // review-ready job; the latest-job check below is the authority.
      jobs: { some: { status: "AWAITING_REVIEW" } },
    },
    select: {
      id: true,
      name: true,
      poNumber: true,
      jobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          _count: { select: { assets: true } },
          assets: { where: { reviewStatus: "PENDING_REVIEW" }, select: { id: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const out: AwaitingApprovalStyle[] = [];
  for (const s of styles) {
    const latest = s.jobs[0];
    if (!latest || latest.status !== "AWAITING_REVIEW") continue;
    out.push({
      id: s.id,
      name: s.name,
      poNumber: s.poNumber,
      outputCount: latest._count.assets,
      pendingCount: latest.assets.length,
    });
  }
  return out;
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

import { db } from "@/lib/db";
import { mondayItemUrl } from "@/lib/monday/url";
import { styleReadinessNotice, type ReadinessNotice } from "@/lib/styles/readiness-notice";
import { parsePoScrapeSnapshot, computeSizeCoverage } from "@/lib/po/scrape-snapshot";
import type { PoScrapeSnapshot, SizeCoverage } from "@/lib/po/scrape-snapshot";
import { loadLookalikes, type LookalikeReport } from "@/lib/styles/related";
import { reconcileStyleFolder, type FolderReconcile } from "@/lib/sharepoint/reconcile-folder";
import { getCurrentOutputsForStyle } from "@/lib/outputs/current-outputs";
import { eanResolveInputs } from "@/lib/po/resolve-inputs";
import { effectiveMapping } from "@/lib/styles/output-readiness";
import type { ExplainPointer } from "@/lib/styles/explain-ai";

// =====================================================
// The style evidence bundle — one deterministic answer to "what's up with
// this style?", assembled from the parts that already know:
//
//   readiness ladder   → what each output is still waiting for
//   PO scrape snapshot → what the Purchase Order PDF actually contained
//   size coverage      → board size run vs what the PO actually covered
//   lookalike rows     → is the reviewer even on the right Monday row?
//   folder reconcile   → what is (and isn't) in the supplier's SharePoint
//   log trail          → what the pipeline said while doing it
//
// This module is the DIAGNOSIS. explain-ai.ts only narrates what it produces,
// and can add nothing to it. Keeping the two apart is the whole safety story:
// every fact a reviewer is shown traces back to a query, never to a model.
//
// Both surfaces read the same bundle — the always-on panel and the free-text
// Q&A — so the AI can never contradict what the page is showing.
// =====================================================

export type StyleExplainFacts = {
  id: string;
  name: string;
  poNumber: string | null;
  customerName: string;
  businessArea: string | null;
  supplierName: string | null;
  prodSpecName: string | null;
  status: string;
  eanStatus: string;
  eanAttempts: number;
  groupTitle: string | null;
  mondayItemId: string;
  mondayBoardId: string;
  boardSizes: string[];
  customerItemNo: string | null;
  consignmentCode: string | null;
  colourCode: string | null;
  poFileName: string | null;
  eanResolvedAt: string | null;
};

export type StyleExplainLogEntry = {
  at: string;
  level: string;
  message: string;
};

export type StyleExplainBundle = {
  facts: StyleExplainFacts;
  readiness: ReadinessNotice;
  outputs: { name: string; state: string; missing: string[] }[];
  poScrape: PoScrapeSnapshot | null;
  sizeCoverage: SizeCoverage | null;
  lookalikes: LookalikeReport | null;
  folder: FolderReconcile | null;
  // Set when the folder check was attempted and failed (Graph down, no
  // credentials). Distinct from `folder: null` meaning "not requested", so a
  // reader is never left guessing which happened.
  folderError: string | null;
  logs: StyleExplainLogEntry[];
};

// How far back the log trail reaches, and how many lines it carries. Bounded
// because `logs` has no styleId column (see below) and the message-match half
// of the query cannot use an index on its own.
const LOG_WINDOW_DAYS = 60;
const LOG_LIMIT = 25;

// This style's log trail. Two sources, because the pipeline writes logs two
// different ways:
//   • generation/publish logs hang off a Job, so they reach the style via the
//     job relation;
//   • the EAN runner writes STYLE-LEVEL logs with NO jobId and no styleId —
//     the id only appears inside the free text ("ean resolve <id>: …"). A
//     message match is the only way to recover those, so that's what we do.
// The createdAt window comes first and is indexed, which keeps the LIKE from
// degenerating into a scan of the whole logs table.
async function loadLogTrail(styleId: string): Promise<StyleExplainLogEntry[]> {
  const since = new Date(Date.now() - LOG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.log.findMany({
    where: {
      createdAt: { gte: since },
      OR: [{ job: { styleId } }, { message: { contains: styleId } }],
    },
    select: { createdAt: true, level: true, message: true },
    orderBy: { createdAt: "desc" },
    take: LOG_LIMIT,
  });
  return rows.map((r) => ({
    at: r.createdAt.toISOString(),
    level: r.level,
    message: r.message,
  }));
}

// Build the bundle. `includeFolder` costs a Microsoft Graph round-trip, so it
// is opt-in: the always-on panel can render without it, while the Q&A path
// asks for it (the "docs didn't land" question is unanswerable otherwise).
// A Graph failure NEVER fails the bundle — everything else is still useful, so
// it degrades to folderError and carries on.
export async function buildStyleExplainBundle(
  styleId: string,
  opts: { includeFolder?: boolean; role?: "ADMIN" | "REVIEWER" } = {},
): Promise<StyleExplainBundle | null> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      id: true,
      name: true,
      poNumber: true,
      poFileName: true,
      rawData: true,
      status: true,
      eanStatus: true,
      eanAttempts: true,
      eanResolvedAt: true,
      groupTitle: true,
      mondayItemId: true,
      mondayBoardId: true,
      cartonEan: true,
      poScrapeSnapshot: true,
      businessArea: true,
      customer: { select: { name: true, config: true } },
      businessAreaRef: { select: { name: true } },
      supplier: { select: { name: true, country: true } },
      prodSpec: { select: { name: true, outputs: true, columnMapping: true } },
      eans: {
        orderBy: { position: "asc" },
        select: { size: true, ean13: true, cartonEan: true, excluded: true, manual: true },
      },
    },
  });
  if (!style) return null;

  // Resolve the style's identity columns through the SAME mapping the PDF
  // mapper and the EAN resolver use, so the bundle can never describe a
  // different Customer Item No / size run than the pipeline acted on.
  const mapping = effectiveMapping({
    rawData: style.rawData,
    customer: { config: style.customer.config },
    prodSpec: style.prodSpec
      ? { outputs: style.prodSpec.outputs, columnMapping: style.prodSpec.columnMapping }
      : null,
  });
  const inputs = eanResolveInputs(style.rawData, mapping, style.name, style.poNumber);

  const [outputs, lookalikes, logs] = await Promise.all([
    getCurrentOutputsForStyle(styleId).catch(() => []),
    loadLookalikes(styleId).catch(() => null),
    loadLogTrail(styleId).catch(() => []),
  ]);

  let folder: FolderReconcile | null = null;
  let folderError: string | null = null;
  if (opts.includeFolder) {
    try {
      folder = await reconcileStyleFolder(styleId);
    } catch (err) {
      folderError = err instanceof Error ? err.message : "Folder check failed";
    }
  }

  const readiness = styleReadinessNotice(
    {
      eanStatus: style.eanStatus,
      eanAttempts: style.eanAttempts,
      poNumber: style.poNumber,
      poFileName: style.poFileName,
      hasProdSpec: Boolean(style.prodSpec),
      prodSpecHasOutputs: Array.isArray(style.prodSpec?.outputs)
        ? (style.prodSpec.outputs as unknown[]).length > 0
        : Boolean(style.prodSpec?.outputs),
      currentOutputs: outputs,
    },
    opts.role ?? "REVIEWER",
  );

  const poScrape = parsePoScrapeSnapshot(style.poScrapeSnapshot);
  const sizeCoverage = inputs.sizes.length > 0 || style.eans.length > 0
    ? computeSizeCoverage(inputs.sizes, style.eans)
    : null;

  return {
    facts: {
      id: style.id,
      name: style.name,
      poNumber: style.poNumber,
      customerName: style.customer.name,
      businessArea: style.businessAreaRef?.name ?? style.businessArea ?? null,
      supplierName: style.supplier?.name ?? null,
      prodSpecName: style.prodSpec?.name ?? null,
      status: style.status,
      eanStatus: style.eanStatus,
      eanAttempts: style.eanAttempts,
      groupTitle: style.groupTitle,
      mondayItemId: style.mondayItemId,
      mondayBoardId: style.mondayBoardId,
      boardSizes: inputs.sizes,
      customerItemNo: inputs.customerItemNo || null,
      consignmentCode: inputs.consignmentCode || null,
      colourCode: inputs.colourCode || null,
      poFileName: style.poFileName,
      eanResolvedAt: style.eanResolvedAt?.toISOString() ?? null,
    },
    readiness,
    outputs: outputs.map((o) => ({
      name: o.name,
      state: o.state,
      missing: o.missing.map((m) => m.label),
    })),
    poScrape,
    sizeCoverage,
    lookalikes,
    folder,
    folderError,
    logs,
  };
}

// The places an answer may send someone. Built from the bundle so every href
// is one WE constructed — explain-ai.ts offers these to the model as id +
// label and maps its returned ids back, so a hallucinated link cannot exist.
export function explainPointers(bundle: StyleExplainBundle): ExplainPointer[] {
  const p: ExplainPointer[] = [];
  const f = bundle.facts;

  if (f.mondayItemId) {
    p.push({
      id: "monday",
      label: "The style's row in Monday — where required fields are filled in",
      href: mondayItemUrl(f.mondayBoardId, f.mondayItemId),
    });
  }
  if (f.poNumber) {
    p.push({
      id: "poEans",
      label: `PO barcodes queue for ${f.poNumber} — scrape state and Re-resolve`,
      href: "/po-eans",
    });
  }
  if (bundle.lookalikes?.matches.length) {
    // Deliberately points at the FIRST lookalike rather than a list: the whole
    // value is landing the reader on the other order to compare it.
    const other = bundle.lookalikes.matches[0];
    p.push({
      id: "lookalike",
      label: `The other Monday row with this name${other.poNumber ? ` (${other.poNumber})` : ""}`,
      href: `/styles/${other.id}`,
    });
  }
  if (f.prodSpecName) {
    p.push({
      id: "prodSpec",
      label: `Prod Spec "${f.prodSpecName}" — which outputs this style generates`,
      href: `/styles/${f.id}?tab=prod-spec`,
    });
  }
  p.push({
    id: "review",
    label: "This style's outputs and review state",
    href: `/styles/${f.id}?tab=review`,
  });
  if (bundle.folder?.folderUrl) {
    p.push({
      id: "supplierFolder",
      label: "The supplier's SharePoint folder for this PO",
      href: bundle.folder.folderUrl,
    });
  }
  return p;
}

import { db } from "@/lib/db";
import { columnText, columnValue, getItem, type MondayItem } from "./client";
import { evaluateCompletion, withSyntheticColumns } from "./completion";
import { resolveCustomerByBoardId, ensureNettoGermany } from "@/lib/customers/resolve";
import { parseCustomerConfig, MANUAL_COLUMN_IDS } from "@/lib/customers/config";
import { MONDAY_STYLE_COLS, MONDAY_PRE_ORDER_COLS, MONDAY_BOARDS } from "./boards";
import { ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";
import { parseProdSpecRequiredFields, parseProdSpecColumnMapping } from "@/lib/prod-spec/config";
import { formatEanMap } from "@/lib/styles/resolved-fields";
import {
  buildCustomerTokenIndex,
  extractLeadingToken,
} from "@/lib/import/heuristics";

// Thrown when ingest cannot proceed but the situation is recoverable by
// the operator (e.g. customer-link is unset AND the leading name token
// matches multiple customers). Distinguished from a hard error so sync
// + webhook code can count "needs operator action" separately from
// "actually broken". Surface in /import for manual disambiguation.
export class IngestSkip extends Error {
  constructor(
    public readonly reason:
      | "ambiguous_customer"
      | "no_customer_match",
    public readonly details: { itemId: string; itemName: string; token?: string | null; candidates?: string[] },
  ) {
    super(`ingest skipped (${reason}): ${details.itemName} [${details.itemId}]`);
    this.name = "IngestSkip";
  }
}

export type IngestResult = {
  styleId: string;
  customerId: string;
  customerSlug: string;
  businessAreaId: string | null;
  supplierId: string | null;
  prodSpecId: string | null;
  completionPct: number;
  missingFields: Array<{ id: string; label: string }>;
  // The auto-gen threshold the caller should compare completionPct against.
  // Comes from ProdSpec.autoGenerateThresholdPct if resolved, otherwise 100.
  autoGenerateThresholdPct: number;
  // Whether the resolved ProdSpec is active. Callers gate Job auto-enqueue
  // on this — an inactive (auto-created, unreviewed) ProdSpec means the
  // admin hasn't approved generating documents yet.
  prodSpecActive: boolean;
  // True when this ingest just (re)queued PO→EAN resolution for the style
  // (PO number filled or changed). Callers fire triggerEanRunner() on it.
  eanQueued: boolean;
};

export async function ingestMondayItem(
  itemId: string | number,
  item?: MondayItem | null,
): Promise<IngestResult> {
  const fetched = item ?? (await getItem(itemId));
  if (!fetched) throw new Error(`Monday item ${itemId} not found`);

  // -----------------------------------------------------
  // Resolve foreign keys from the local Monday mirrors.
  // Each lookup falls back gracefully when the source column id isn't
  // configured yet (Phase-2 sometimes ships before all column ids are
  // known) — the Style still upserts, just with looser links.
  // -----------------------------------------------------

  // Board-aware column source. Styles are sourced from the Pre-Order board
  // (current source of truth); the Styles board path is kept so legacy /
  // manual items still ingest. Each board exposes the same logical fields
  // under different column ids.
  const cols =
    fetched.board.id === MONDAY_BOARDS.preOrder
      ? {
          businessArea: MONDAY_PRE_ORDER_COLS.businessArea,
          customerLink: MONDAY_PRE_ORDER_COLS.customerLink,
          supplierLink: MONDAY_PRE_ORDER_COLS.supplierLink,
          poNumber: MONDAY_PRE_ORDER_COLS.poNumber,
          styleFolderUrl: MONDAY_PRE_ORDER_COLS.styleFolderUrl,
        }
      : MONDAY_STYLE_COLS;

  const businessAreaText = cols.businessArea
    ? columnText(fetched, cols.businessArea) || null
    : null;

  const businessAreaId = businessAreaText ? await resolveBusinessAreaId(businessAreaText) : null;

  const customerLinkId = cols.customerLink
    ? extractLinkedItemId(columnValue(fetched, cols.customerLink))
    : null;
  const supplierLinkId = cols.supplierLink
    ? extractLinkedItemId(columnValue(fetched, cols.supplierLink))
    : null;

  const customer =
    (customerLinkId ? await db.customer.findUnique({ where: { mondayItemId: customerLinkId } }) : null) ??
    (await resolveCustomerByBoardId(fetched.board.id))?.customer ??
    (await resolveCustomerByNameToken(fetched.name)) ??
    // Styles + Pre-Order are real upstream boards: an unmatched customer is
    // an operator-action case (skip → surfaced in /import), NOT a silent
    // fallback to Netto Germany (which is only for offline manual items).
    (fetched.board.id === MONDAY_BOARDS.styles || fetched.board.id === MONDAY_BOARDS.preOrder
      ? null
      : await ensureNettoGermany());

  if (!customer) {
    // Customer link is unset AND the leading-name token is either
    // unmatched or ambiguous. Throw a STRUCTURED skip so sync/webhook
    // callers can count "needs operator action" separately from real
    // errors. Surface in /import for manual disambiguation.
    const token = extractLeadingToken(fetched.name);
    if (token) {
      const trie = await getCustomerTokenTrie();
      const matches = trie.get(token.toLowerCase()) ?? [];
      if (matches.length > 1) {
        throw new IngestSkip("ambiguous_customer", {
          itemId: String(fetched.id),
          itemName: fetched.name,
          token,
          candidates: matches.map((m) => m.name),
        });
      }
    }
    throw new IngestSkip("no_customer_match", {
      itemId: String(fetched.id),
      itemName: fetched.name,
      token,
    });
  }

  const supplier = supplierLinkId
    ? await db.supplier.findUnique({ where: { mondayItemId: supplierLinkId } })
    : null;

  const poNumber = cols.poNumber
    ? columnText(fetched, cols.poNumber) || null
    : null;
  const styleFolderUrl = cols.styleFolderUrl
    ? extractLinkUrl(columnValue(fetched, cols.styleFolderUrl)) ||
      columnText(fetched, cols.styleFolderUrl) ||
      null
    : null;

  // -----------------------------------------------------
  // Resolve the matching ProdSpec. Auto-create when both Customer and
  // BusinessArea are known but no ProdSpec exists for the pair yet —
  // operators can tune outputs/requiredFields in the admin UI after.
  // -----------------------------------------------------
  let prodSpec = null as Awaited<ReturnType<typeof db.prodSpec.findUnique>>;
  if (businessAreaId) {
    prodSpec = await db.prodSpec.findUnique({
      where: { customerId_businessAreaId: { customerId: customer.id, businessAreaId } },
    });
    if (!prodSpec) {
      await ensureProdSpecsForStyle(customer.id, businessAreaId);
      prodSpec = await db.prodSpec.findUnique({
        where: { customerId_businessAreaId: { customerId: customer.id, businessAreaId } },
      });
    }
  }

  // Required-field set: ProdSpec wins if non-empty, otherwise inherit
  // from Customer.config.requiredFields (M2 behaviour).
  const customerConfig = parseCustomerConfig(customer.config);
  const prodSpecRequired = prodSpec
    ? parseProdSpecRequiredFields(prodSpec.requiredFields)
    : [];
  const requiredFields = prodSpecRequired.length > 0 ? prodSpecRequired : customerConfig.requiredFields;

  // Snapshot the prior PO + EAN state. Detects a PO that was just filled
  // (or changed) for the (re)queue below, AND feeds completion: barcodes
  // already resolved from the PO PDF count as the ean13/cartonEan columns
  // being filled, so a re-ingest on an unrelated edit doesn't knock a
  // resolved style back below 100%.
  const prevEan = await db.style.findUnique({
    where: { mondayItemId: String(fetched.id) },
    select: {
      poNumber: true,
      eanStatus: true,
      cartonEan: true,
      // Current workflow status — guards the upsert below from downgrading
      // post-generation states back to READY/PENDING on re-sync.
      status: true,
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
    },
  });

  // Completion counts a required column as filled when the Monday column
  // has a value OR the EAN runner resolved it from the PO PDF. Required
  // fields are keyed by raw column id, so the resolved values are injected
  // under the effective mapping's ids (ProdSpec override → customer) and
  // the manual.* ids.
  const psMappingRaw = prodSpec?.columnMapping;
  const mapping =
    psMappingRaw && typeof psMappingRaw === "object" && Object.keys(psMappingRaw).length > 0
      ? parseProdSpecColumnMapping(psMappingRaw)
      : customerConfig.columnMapping;
  const eanMapText = formatEanMap(prevEan?.eans);
  const completionItem = withSyntheticColumns(fetched, [
    { id: mapping.ean13 ?? "", text: eanMapText },
    { id: MANUAL_COLUMN_IDS.ean13, text: eanMapText },
    { id: mapping.cartonEan ?? "", text: prevEan?.cartonEan ?? "" },
    { id: MANUAL_COLUMN_IDS.cartonEan, text: prevEan?.cartonEan ?? "" },
  ]);
  const { completionPct, missingFields } = evaluateCompletion(completionItem, requiredFields);
  const status = completionPct === 100 ? "READY" : "PENDING";
  // Completion only ever moves a style between the two PRE-generation
  // states. Once the jobs pipeline owns the status (GENERATING /
  // AWAITING_REVIEW / APPROVED / REJECTED) a re-sync must not downgrade it
  // — this clobbered review states on every Monday edit. Same guard as the
  // manual-edit route (src/app/api/admin/styles/[id]/route.ts).
  const keepWorkflowStatus = prevEan != null && !["PENDING", "READY"].includes(prevEan.status);

  // Store the Monday snapshot, plus a synthetic "__name__" column carrying
  // the row name (the Contrast IL-code) so the styleNumber field can map to
  // it. Pre-Order is the native source now, so there's no "po.*" enrichment
  // overlay to preserve.
  const mergedRawData = {
    ...(fetched as unknown as Record<string, unknown>),
    column_values: [
      ...fetched.column_values,
      { id: "__name__", type: "name", text: fetched.name, value: null },
    ],
  };

  const style = await db.style.upsert({
    where: { mondayItemId: String(fetched.id) },
    create: {
      customerId: customer.id,
      businessAreaId: businessAreaId,
      supplierId: supplier?.id ?? null,
      prodSpecId: prodSpec?.id ?? null,
      mondayItemId: String(fetched.id),
      mondayBoardId: fetched.board.id,
      name: fetched.name,
      businessArea: businessAreaText,
      poNumber,
      styleFolderUrl,
      groupId: fetched.group?.id ?? null,
      groupTitle: fetched.group?.title ?? null,
      rawData: mergedRawData as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      status,
      lastSyncedAt: new Date(),
    },
    update: {
      customerId: customer.id,
      businessAreaId: businessAreaId,
      supplierId: supplier?.id ?? null,
      prodSpecId: prodSpec?.id ?? null,
      mondayBoardId: fetched.board.id,
      name: fetched.name,
      businessArea: businessAreaText,
      poNumber,
      styleFolderUrl,
      groupId: fetched.group?.id ?? null,
      groupTitle: fetched.group?.title ?? null,
      rawData: mergedRawData as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      ...(keepWorkflowStatus ? {} : { status }),
      lastSyncedAt: new Date(),
    },
  });

  // -----------------------------------------------------
  // PO → EAN resolution trigger. Style.eanStatus is the work queue: when a
  // PO number is freshly filled (or changed), flip the style to PENDING so
  // the EAN runner scrapes the PO PDF and reads out the per-size barcodes.
  // We deliberately DON'T re-queue on unrelated column edits when the PO is
  // unchanged and already past NONE — the cron sweep retries non-terminal
  // outcomes (e.g. a PO whose barcode page isn't there yet).
  // -----------------------------------------------------
  let eanQueued = false;
  if (!poNumber) {
    // PO cleared / never set — reset to NONE if it was tracking one.
    if (prevEan && prevEan.eanStatus !== "NONE") {
      await db.style.update({
        where: { id: style.id },
        data: { eanStatus: "NONE", eanResolveStartedAt: null },
      });
    }
  } else if (prevEan?.poNumber !== poNumber || (prevEan?.eanStatus ?? "NONE") === "NONE") {
    await db.style.update({
      where: { id: style.id },
      data: { eanStatus: "PENDING", eanResolveStartedAt: null },
    });
    eanQueued = true;
  }

  return {
    styleId: style.id,
    customerId: customer.id,
    customerSlug: customer.slug,
    businessAreaId,
    supplierId: supplier?.id ?? null,
    prodSpecId: prodSpec?.id ?? null,
    completionPct,
    missingFields,
    autoGenerateThresholdPct: prodSpec?.autoGenerateThresholdPct ?? 100,
    prodSpecActive: prodSpec?.active ?? false,
    eanQueued,
  };
}

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

async function resolveBusinessAreaId(label: string): Promise<string> {
  const ba = await db.businessArea.upsert({
    where: { mondayValue: label },
    create: { mondayValue: label, name: label, lastSyncedAt: new Date(), active: true },
    update: { lastSyncedAt: new Date() },
    select: { id: true, mergedIntoId: true },
  });
  // Follow the alias chain — operators may have merged this Monday-side
  // variant into a canonical BA (e.g. "PL" → "Private Label"). We honour
  // one hop here; the merge endpoint forbids chains so a single redirect
  // is enough. If your alias somehow points to another alias, the worst
  // case is the Style links to the immediate target — not broken, just
  // not fully canonicalised. The next admin merge cleans it up.
  return ba.mergedIntoId ?? ba.id;
}

// Match a Style by its leading name token (e.g. "JYSK [Malte small]" →
// trie key "jysk") against the active Customer set. Returns the matched
// Customer when the trie hit is UNIQUE — ambiguous matches (JYSK A/S vs
// JYSK SE) deliberately return null so the live ingest skips them and
// the operator picks the right one via the /import disambiguation
// bucket. Trie is module-cached for 60 s so a 4 k-item sync doesn't
// re-query the customers table per row.
let customerTrieCache:
  | { trie: Map<string, Array<{ id: string; name: string }>>; expiresAt: number }
  | null = null;
const CUSTOMER_TRIE_TTL_MS = 60_000;

async function getCustomerTokenTrie() {
  if (customerTrieCache && Date.now() < customerTrieCache.expiresAt) {
    return customerTrieCache.trie;
  }
  const customers = await db.customer.findMany({
    where: { active: true },
    select: { id: true, name: true },
  });
  const trie = buildCustomerTokenIndex(customers);
  customerTrieCache = { trie, expiresAt: Date.now() + CUSTOMER_TRIE_TTL_MS };
  return trie;
}

async function resolveCustomerByNameToken(name: string) {
  const token = extractLeadingToken(name);
  if (!token) return null;
  const trie = await getCustomerTokenTrie();
  const matches = trie.get(token.toLowerCase()) ?? [];
  if (matches.length !== 1) return null;
  return db.customer.findUnique({ where: { id: matches[0].id } });
}

function extractLinkedItemId(raw: unknown): string | null {
  // Monday "item connect" columns expose `linkedPulseIds: [{ linkedPulseId: 123 }, ...]`
  // in their JSON value. We take the first id — current spec is single-link
  // per style for both customer and supplier.
  if (!raw || typeof raw !== "object") return null;
  const link = raw as { linkedPulseIds?: Array<{ linkedPulseId?: number | string }> };
  const first = link.linkedPulseIds?.[0]?.linkedPulseId;
  return first != null ? String(first) : null;
}

function extractLinkUrl(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "url" in raw && typeof (raw as { url: unknown }).url === "string") {
    return (raw as { url: string }).url || null;
  }
  return null;
}

export type LifecycleResult = { matched: boolean; styleId?: string };

// Soft lifecycle handlers (ported from the Monday webhooks work). We never
// hard-delete: an archived / deleted Monday item is flagged so the row + its
// Log trail survive for audit, and the UI stops surfacing it. Idempotent —
// re-stamping an already-flagged row is fine.
export async function markStyleArchived(itemId: string | number): Promise<LifecycleResult> {
  const result = await db.style.updateMany({
    where: { mondayItemId: String(itemId), archivedAt: null },
    data: { archivedAt: new Date() },
  });
  const style = await db.style.findUnique({ where: { mondayItemId: String(itemId) }, select: { id: true } });
  return { matched: result.count > 0 || style !== null, styleId: style?.id };
}

export async function markStyleDeleted(itemId: string | number): Promise<LifecycleResult> {
  const result = await db.style.updateMany({
    where: { mondayItemId: String(itemId), deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const style = await db.style.findUnique({ where: { mondayItemId: String(itemId) }, select: { id: true } });
  return { matched: result.count > 0 || style !== null, styleId: style?.id };
}

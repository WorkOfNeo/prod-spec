import { db } from "@/lib/db";
import { parsePoNumberValue } from "@/lib/po/po-number";
import { columnText, findItemsByColumnValues, type MondayItem } from "@/lib/monday/client";
import { MONDAY_BOARDS, MONDAY_PRE_ORDER_COLS } from "@/lib/monday/boards";
import { ingestMondayItem, IngestSkip } from "@/lib/monday/ingest";
import { resolveAndPersistStyleEans } from "@/lib/po/ean-runner";

// "Pull style by PO" (Settings) — pull a historical/hidden style into the
// styleboard for layout testing. Two-step: a preview (DB-first, Monday as the
// authoritative source for what's on the board for that PO), then an import
// that refreshes each selected item from Monday, re-ingests it, and pins it
// (Style.pulledForTestAt) so it shows on /styles regardless of its group.

// One row in the preview the operator confirms against.
export type PullCandidate = {
  // Monday Pre-Order item id — the stable key we import / dedupe on.
  mondayItemId: string;
  name: string;
  poNumber: string | null;
  businessArea: string | null;
  // Best-effort: known only when the style is already in our DB; for board-only
  // items the customer is resolved during import (ingest), so it's null here.
  customerName: string | null;
  groupTitle: string | null;
  // Already a Style row in our DB (just possibly hidden by its group).
  inDb: boolean;
  styleId: string | null;
  // Already pinned (pulledForTestAt set) — i.e. already on the styleboard.
  alreadyPulled: boolean;
};

// The PO forms operators paste vary ("C-62498", "62498", "C-PO62498"); build
// the variants worth firing at Monday's exact-match column search. Returns []
// when the input carries no recognisable PO.
function poQueryVariants(input: string): string[] {
  const trimmed = input.trim();
  const seq = parsePoNumberValue(trimmed);
  const variants = new Set<string>();
  if (trimmed) variants.add(trimmed);
  if (seq != null) {
    const digits = String(seq);
    variants.add(digits);
    variants.add(`C-${digits}`);
    variants.add(`C-PO${digits}`);
  }
  return [...variants];
}

// Look up every style matching a PO, merging our DB and the Monday Pre-Order
// board so the operator sees both already-synced styles (possibly hidden) and
// any board item not yet ingested. Keyed/deduped by Monday item id.
export async function previewStylesByPo(input: string): Promise<{
  poSeq: number | null;
  candidates: PullCandidate[];
}> {
  const poSeq = parsePoNumberValue(input);
  const variants = poQueryVariants(input);

  // DB-first: match on the numeric poSeq when present, plus a poNumber substring
  // fallback for rows whose poSeq was never backfilled.
  const digits = poSeq != null ? String(poSeq) : null;
  const dbRows =
    variants.length > 0
      ? await db.style.findMany({
          where: {
            OR: [
              ...(poSeq != null ? [{ poSeq }] : []),
              ...(digits ? [{ poNumber: { contains: digits } }] : []),
            ],
          },
          select: {
            id: true,
            mondayItemId: true,
            name: true,
            poNumber: true,
            businessArea: true,
            groupTitle: true,
            pulledForTestAt: true,
            customer: { select: { name: true } },
            businessAreaRef: { select: { name: true } },
          },
        })
      : [];

  // Monday Pre-Order board — authoritative list of items carrying this PO.
  let mondayItems: MondayItem[] = [];
  if (variants.length > 0) {
    try {
      mondayItems = await findItemsByColumnValues(
        MONDAY_BOARDS.preOrder,
        MONDAY_PRE_ORDER_COLS.poNumber,
        variants,
      );
    } catch {
      // Monday hiccup shouldn't blank the preview — fall back to DB matches.
      mondayItems = [];
    }
  }

  const byId = new Map<string, PullCandidate>();
  const dbByMondayId = new Map(dbRows.map((r) => [r.mondayItemId, r]));

  for (const item of mondayItems) {
    const dbRow = dbByMondayId.get(item.id);
    byId.set(item.id, {
      mondayItemId: item.id,
      name: item.name,
      poNumber: columnText(item, MONDAY_PRE_ORDER_COLS.poNumber) || dbRow?.poNumber || null,
      businessArea:
        columnText(item, MONDAY_PRE_ORDER_COLS.businessArea) ||
        dbRow?.businessAreaRef?.name ||
        dbRow?.businessArea ||
        null,
      customerName: dbRow?.customer?.name ?? null,
      groupTitle: item.group?.title ?? dbRow?.groupTitle ?? null,
      inDb: !!dbRow,
      styleId: dbRow?.id ?? null,
      alreadyPulled: !!dbRow?.pulledForTestAt,
    });
  }

  // DB rows the Monday query missed (e.g. a PO format mismatch on the board).
  for (const r of dbRows) {
    if (byId.has(r.mondayItemId)) continue;
    byId.set(r.mondayItemId, {
      mondayItemId: r.mondayItemId,
      name: r.name,
      poNumber: r.poNumber,
      businessArea: r.businessAreaRef?.name ?? r.businessArea ?? null,
      customerName: r.customer?.name ?? null,
      groupTitle: r.groupTitle,
      inDb: true,
      styleId: r.id,
      alreadyPulled: !!r.pulledForTestAt,
    });
  }

  return { poSeq, candidates: [...byId.values()] };
}

export type PullResult = {
  pulled: Array<{ styleId: string; name: string }>;
  skipped: Array<{ mondayItemId: string; reason: string }>;
  errors: Array<{ mondayItemId: string; error: string }>;
};

// Refresh each selected Monday item, (re)ingest it, and pin it onto the
// styleboard. Refresh-from-Monday is deliberate: the operator is testing
// layouts and wants the freshest field/EAN state. Output generation is NOT
// triggered here — the operator runs that from /styles.
//
// EAN resolution is run DIRECTLY here, not left to the queue. The passive
// ingest path only queues PENDING when a PO is newly filled or *changed*, and
// the cron runner/sweep deliberately skips the parked backlog (lower PO / null
// poSeq) and short-circuits when the auto-run toggle is off. Pulled styles are
// almost always historical rows with an unchanged PO below the cutoff, so none
// of those would ever fire — they'd sit unresolved. Pulling is an explicit
// operator action (like clicking "Re-resolve" per row), so we resolve each
// pulled style end-to-end on the spot, bypassing the toggle and the cutoff.
export async function pullStylesByPo(mondayItemIds: string[]): Promise<PullResult> {
  const ids = [...new Set(mondayItemIds.map((s) => s.trim()).filter(Boolean))];
  const result: PullResult = { pulled: [], skipped: [], errors: [] };

  for (const itemId of ids) {
    try {
      const ingest = await ingestMondayItem(itemId);
      await db.style.update({
        where: { id: ingest.styleId },
        data: { pulledForTestAt: new Date() },
      });
      const style = await db.style.findUnique({
        where: { id: ingest.styleId },
        select: { name: true, poNumber: true },
      });
      result.pulled.push({ styleId: ingest.styleId, name: style?.name ?? itemId });

      // Resolve the barcodes now. Mirrors the per-row "Re-resolve" override:
      // clear the strike counter so a floated row un-floats and gets a fresh
      // budget, then resolve + persist. A scrape failure must NOT fail the
      // pull — the style is already pulled; its EANs just stay where they were.
      if (style?.poNumber) {
        try {
          await db.style.update({ where: { id: ingest.styleId }, data: { eanAttempts: 0 } });
          await resolveAndPersistStyleEans(ingest.styleId);
        } catch (eanErr) {
          await db.log.create({
            data: {
              level: "WARN",
              message: `pull-by-PO: EAN resolve failed for ${ingest.styleId}: ${
                eanErr instanceof Error ? eanErr.message : "unknown"
              }`,
            },
          });
        }
      }
    } catch (e) {
      if (e instanceof IngestSkip) {
        const reason =
          e.reason === "ambiguous_customer"
            ? `Ambiguous customer (${e.details.candidates?.join(", ") ?? "?"}) — disambiguate in /import`
            : "No matching customer — resolve in /import";
        result.skipped.push({ mondayItemId: itemId, reason });
      } else {
        result.errors.push({
          mondayItemId: itemId,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }
  }

  return result;
}

// Currently-pulled styles, for the Settings management list.
export async function listPulledStyles(): Promise<
  Array<{ id: string; name: string; poNumber: string | null; customerName: string }>
> {
  const rows = await db.style.findMany({
    where: { pulledForTestAt: { not: null } },
    orderBy: { pulledForTestAt: "desc" },
    select: {
      id: true,
      name: true,
      poNumber: true,
      customer: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    poNumber: r.poNumber,
    customerName: r.customer.name,
  }));
}

// Un-pull — clear the pin so the style returns to normal visibility rules.
export async function unpullStyle(styleId: string): Promise<boolean> {
  const res = await db.style.updateMany({
    where: { id: styleId, pulledForTestAt: { not: null } },
    data: { pulledForTestAt: null },
  });
  return res.count > 0;
}

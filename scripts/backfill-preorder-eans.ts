import { MONDAY_BOARDS, MONDAY_PRE_ORDER_COLS } from "@/lib/monday/boards";
import { getBoardItems, getNextItemsPage } from "@/lib/monday/client-pagination";
import { columnText, type MondayItem } from "@/lib/monday/client";
import { ingestMondayItem, IngestSkip } from "@/lib/monday/ingest";
import { db } from "@/lib/db";

// =====================================================
// One-time backfill: ingest Pre-Order rows whose PO number is ABOVE a
// given C-PO number — regardless of which group they sit in ("Done"
// included). Rows that predate the webhook integration never produced
// events, and the /import funnel skips archived groups, so their POs
// were never queued for EAN parsing.
//
//   npm run backfill-preorder-eans                    # dry run vs C-PO63144
//   npm run backfill-preorder-eans -- --above 63144   # explicit threshold
//   npm run backfill-preorder-eans -- --apply         # ingest + queue
//
// What --apply does per matching row: ingestMondayItem() — the exact same
// path the live webhook uses (Style upsert, ProdSpec auto-scaffold,
// EAN queue flip to PENDING when the PO is new/changed). It does NOT
// enqueue render Jobs (that decision stays with the normal callers), and
// ingest is idempotent — re-running refreshes rows and re-queues nothing
// that's already resolved.
//
// QUEUE ONLY — nothing is scraped by this script. The queued rows show on
// /po-eans; scraping happens when an operator clicks "Re-resolve" there
// (per row or batch), or automatically once the "Automatic barcode
// scraping" switch on /po-eans is turned on.
// =====================================================

const APPLY = process.argv.includes("--apply");
const aboveArg = process.argv.indexOf("--above");
const ABOVE = aboveArg !== -1 ? Number(process.argv[aboveArg + 1]) : 63144;

// "C-PO63144", "C-PO 63144", "63144" → 63144 (last digit run wins).
function parsePoNumber(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : null;
}

async function fetchAllPreOrderItems(): Promise<MondayItem[]> {
  const items: MondayItem[] = [];
  let page = await getBoardItems(MONDAY_BOARDS.preOrder, 200);
  items.push(...page.items);
  while (page.cursor) {
    page = await getNextItemsPage(page.cursor, 200);
    items.push(...page.items);
    process.stdout.write(`\r  fetched ${items.length} pre-order rows…`);
  }
  process.stdout.write("\n");
  return items;
}

async function main() {
  if (!Number.isFinite(ABOVE)) throw new Error(`--above must be a number, got "${process.argv[aboveArg + 1]}"`);
  console.log(
    `Pre-Order EAN backfill — POs above C-PO${ABOVE} — ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`,
  );

  const items = await fetchAllPreOrderItems();
  console.log(`Board ${MONDAY_BOARDS.preOrder}: ${items.length} rows total.\n`);

  const matches = items
    .map((item) => ({
      item,
      po: columnText(item, MONDAY_PRE_ORDER_COLS.poNumber) || null,
      poNum: parsePoNumber(columnText(item, MONDAY_PRE_ORDER_COLS.poNumber) || null),
    }))
    .filter((m): m is typeof m & { poNum: number } => m.poNum !== null && m.poNum > ABOVE)
    .sort((a, b) => a.poNum - b.poNum);

  // Current local state per row, so the plan shows what's new vs refresh.
  const existing = await db.style.findMany({
    where: { mondayItemId: { in: matches.map((m) => String(m.item.id)) } },
    select: { mondayItemId: true, eanStatus: true, poNumber: true },
  });
  const byItemId = new Map(existing.map((s) => [s.mondayItemId, s]));

  console.log(`${matches.length} rows with PO > C-PO${ABOVE}:`);
  for (const m of matches) {
    const tracked = byItemId.get(String(m.item.id));
    const state = tracked
      ? `tracked (eanStatus=${tracked.eanStatus}${tracked.poNumber !== m.po ? `, PO changed from ${tracked.poNumber ?? "—"}` : ""})`
      : "NOT tracked — will ingest fresh";
    console.log(
      `  ${m.po}  [${m.item.group?.title ?? "?"}]  ${m.item.name}  → ${state}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to ingest + queue.`);
    return;
  }

  // ---- ingest every match through the live pipeline ----
  let ingested = 0;
  let queued = 0;
  const skips: string[] = [];
  const errors: string[] = [];
  for (const m of matches) {
    try {
      const result = await ingestMondayItem(m.item.id, m.item);
      ingested++;
      if (result.eanQueued) queued++;
    } catch (err) {
      if (err instanceof IngestSkip) {
        skips.push(`${m.po} ${m.item.name}: ${err.reason}${err.details.candidates ? ` (${err.details.candidates.join(" / ")})` : ""}`);
      } else {
        errors.push(`${m.po} ${m.item.name}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`\nIngested ${ingested}/${matches.length}; EAN resolution queued for ${queued}.`);
  if (skips.length) {
    console.log(`\nSkipped by ingest (needs operator action in /import):`);
    for (const s of skips) console.log(`  ! ${s}`);
  }
  if (errors.length) {
    console.log(`\nErrors:`);
    for (const e of errors) console.log(`  ✗ ${e}`);
  }

  console.log(
    `\nQueued only — nothing was scraped. The rows now show on /po-eans; ` +
      `click "Re-resolve" there to scrape (or enable "Automatic barcode scraping" when ready).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

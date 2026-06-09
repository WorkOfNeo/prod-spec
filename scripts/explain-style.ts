// scripts/explain-style.ts
//
// Diagnose why a specific Styles-board item would (or wouldn't) be
// promoted by a Fill run. Read-only — no upserts, no enqueues.
//
//   tsx --env-file=.env scripts/explain-style.ts <query> [<query> ...]
//
// Each query can be:
//   - a Monday item id            (e.g. 18274531919)
//   - a name fragment             (e.g. "JYSK [Malte")
//   - the Style.id from our DB    (cuid, e.g. cmpq...)
//
// Output explains, per match, the customer / BA / PO resolution and
// what Fill would do today: succeed, skip (with reason + candidates),
// or fail. Mirrors src/lib/monday/ingest.ts logic.

import { db } from "@/lib/db";
import { columnText, columnValue, getItem, type MondayItem } from "@/lib/monday/client";
import { MONDAY_BOARDS, MONDAY_STYLE_COLS } from "@/lib/monday/boards";
import { resolveCustomerByBoardId } from "@/lib/customers/resolve";
import {
  buildCustomerTokenIndex,
  extractLeadingToken,
  extractLinkedItemId,
  BLANK_BA_VALUES,
} from "@/lib/import/heuristics";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "usage: tsx --env-file=.env scripts/explain-style.ts <monday-item-id | name-fragment | style-id> [...]",
    );
    process.exit(1);
  }
  for (const arg of args) {
    await explain(arg);
    console.log("");
  }
  await db.$disconnect();
}

async function explain(query: string) {
  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: MONDAY_BOARDS.styles },
  });
  if (!board) {
    console.log("Styles board not found in ghost mirror — run Sync first.");
    return;
  }

  // Find matching ghost item(s). Try mondayItemId exact, then Style.id,
  // then case-insensitive name LIKE.
  let ghostItems: Array<{ id: string; mondayItemId: string; name: string }> = [];

  if (/^\d+$/.test(query)) {
    ghostItems = await db.mondayGhostItem.findMany({
      where: { boardId: board.id, mondayItemId: query },
      select: { id: true, mondayItemId: true, name: true },
    });
  }
  if (ghostItems.length === 0 && query.startsWith("cm")) {
    // Looks like a cuid — try our Style.id
    const style = await db.style.findUnique({
      where: { id: query },
      select: { mondayItemId: true },
    });
    if (style) {
      ghostItems = await db.mondayGhostItem.findMany({
        where: { boardId: board.id, mondayItemId: style.mondayItemId },
        select: { id: true, mondayItemId: true, name: true },
      });
    }
  }
  if (ghostItems.length === 0) {
    ghostItems = await db.mondayGhostItem.findMany({
      where: { boardId: board.id, name: { contains: query, mode: "insensitive" } },
      orderBy: { name: "asc" },
      select: { id: true, mondayItemId: true, name: true },
      take: 10,
    });
  }

  if (ghostItems.length === 0) {
    console.log(`✗ no Styles ghost match for "${query}"`);
    return;
  }
  if (ghostItems.length > 1) {
    console.log(`(${ghostItems.length} matches for "${query}" — explaining all)`);
  }

  for (const ghost of ghostItems) {
    await explainOne(ghost.mondayItemId, ghost.name);
  }
}

async function explainOne(mondayItemId: string, fallbackName: string) {
  console.log(`\n=== ${fallbackName} ===`);
  console.log(`Monday item id: ${mondayItemId}`);

  // Existing Style row?
  const existing = await db.style.findUnique({
    where: { mondayItemId },
    include: {
      customer: { select: { slug: true, name: true } },
      businessAreaRef: { select: { name: true, mondayValue: true } },
      supplier: { select: { name: true } },
      prodSpec: { select: { id: true, name: true } },
    },
  });
  if (existing) {
    console.log(`✓ Style row exists in DB`);
    console.log(`    db id     ${existing.id}`);
    console.log(`    customer  ${existing.customer.name} (${existing.customer.slug})`);
    console.log(
      `    BA        ${existing.businessAreaRef?.name ?? "(none)"} ${
        existing.businessAreaRef?.mondayValue
          ? `[${existing.businessAreaRef.mondayValue}]`
          : ""
      }`,
    );
    console.log(`    supplier  ${existing.supplier?.name ?? "(none)"}`);
    console.log(`    prodSpec  ${existing.prodSpec?.name ?? "(none)"}`);
    console.log(`    status    ${existing.status} · completion ${existing.completionPct}%`);
    console.log(`    poNumber  ${existing.poNumber ?? "(none)"}`);
  } else {
    console.log(`• No Style row in DB — would be created on Fill if not skipped.`);
  }

  // Fetch LIVE from Monday so the diagnosis matches what Fill will see.
  let fetched: MondayItem | null = null;
  try {
    fetched = await getItem(mondayItemId);
  } catch (err) {
    console.log(`✗ Could not fetch from Monday: ${(err as Error).message}`);
    return;
  }
  if (!fetched) {
    console.log(`✗ Monday returned no item for id ${mondayItemId}`);
    return;
  }

  // ---------- Customer resolution (mirrors ingest.ts) ----------
  const customerLinkId = MONDAY_STYLE_COLS.customerLink
    ? extractLinkedItemId(columnValue(fetched, MONDAY_STYLE_COLS.customerLink))
    : null;

  console.log("\n── Customer resolution ──");
  console.log(
    `  customer__1 link id: ${customerLinkId ?? "(empty)"}` +
      (MONDAY_STYLE_COLS.customerLink
        ? ""
        : `  [MONDAY_STYLE_COL_CUSTOMER_LINK env var not set!]`),
  );

  let resolved: { source: string; customer: { id: string; name: string; slug: string } } | null =
    null;
  let skipReason: string | null = null;
  const candidates: Array<{ id: string; name: string }> = [];

  if (customerLinkId) {
    const c = await db.customer.findUnique({
      where: { mondayItemId: customerLinkId },
      select: { id: true, name: true, slug: true },
    });
    if (c) {
      resolved = { source: "customerLink", customer: c };
      console.log(`  ✓ matched via customerLink → ${c.name} (${c.slug})`);
    } else {
      console.log(`  ✗ customerLink points to ${customerLinkId} but no local Customer mirrors that Monday id`);
    }
  }
  if (!resolved) {
    const byBoard = await resolveCustomerByBoardId(fetched.board.id);
    if (byBoard) {
      resolved = { source: "boardId", customer: byBoard.customer };
      console.log(
        `  ✓ matched via Customer.config.mondayBoardIds → ${byBoard.customer.name}`,
      );
    } else {
      console.log(`  • resolveCustomerByBoardId(${fetched.board.id}) = null (Styles board is shared)`);
    }
  }
  if (!resolved) {
    const token = extractLeadingToken(fetched.name);
    console.log(`  • leading name token: ${token ?? "(none)"}`);
    if (token) {
      const customers = await db.customer.findMany({
        where: { active: true },
        select: { id: true, name: true, slug: true },
      });
      const trie = buildCustomerTokenIndex(customers);
      const matches = trie.get(token.toLowerCase()) ?? [];
      candidates.push(...matches);
      if (matches.length === 1) {
        const full = customers.find((c) => c.id === matches[0].id)!;
        resolved = { source: "nameToken (unique)", customer: full };
        console.log(`  ✓ matched via unique name-token → ${full.name} (${full.slug})`);
      } else if (matches.length === 0) {
        skipReason = "no_customer_match";
        console.log(`  ✗ name token "${token}" matches zero active Customers`);
      } else {
        skipReason = "ambiguous_customer";
        console.log(`  ✗ name token "${token}" is ambiguous — ${matches.length} candidates:`);
        for (const m of matches) console.log(`     - ${m.name}`);
      }
    } else {
      skipReason = "no_customer_match";
      console.log(`  ✗ no usable leading token in name`);
    }
  }

  // ---------- BA resolution ----------
  console.log("\n── Business Area ──");
  const baText = MONDAY_STYLE_COLS.businessArea
    ? columnText(fetched, MONDAY_STYLE_COLS.businessArea) || null
    : null;
  console.log(`  BA column text: ${baText === null ? "(empty)" : JSON.stringify(baText)}`);
  if (baText && BLANK_BA_VALUES.has(baText)) {
    console.log(`  • BA text is one of BLANK_BA_VALUES — treated as blank`);
  } else if (baText) {
    const ba =
      (await db.businessArea.findFirst({
        where: { mondayValue: { equals: baText, mode: "insensitive" } },
      })) ??
      (await db.businessArea.findFirst({
        where: { name: { equals: baText, mode: "insensitive" } },
      }));
    if (ba) {
      console.log(`  ✓ resolves to BusinessArea: ${ba.name} (mondayValue=${ba.mondayValue})`);
    } else {
      console.log(`  ✗ no BusinessArea row matches — would store as free-text fallback`);
    }
  }

  // ---------- PO ----------
  const poText = MONDAY_STYLE_COLS.poNumber
    ? columnText(fetched, MONDAY_STYLE_COLS.poNumber) || null
    : null;
  console.log(`\n── PO Number ──`);
  console.log(`  ${poText === null ? "(empty / column id not configured)" : JSON.stringify(poText)}`);

  // ---------- Verdict ----------
  console.log(`\n── Fill verdict ──`);
  if (resolved) {
    console.log(`  ✓ Would SYNC. Customer: ${resolved.customer.name} (via ${resolved.source}).`);
    if (existing) {
      console.log(`    → updates the existing Style row.`);
    } else {
      console.log(`    → creates a new Style row.`);
    }
  } else if (skipReason === "ambiguous_customer") {
    console.log(`  ⚠ Would SKIP — reason: ambiguous_customer`);
    console.log(`    Surfaces in /import "Needs disambiguation" if BA + ProdSpec resolve.`);
    console.log(`    Fix: set customer__1 in Monday to the right entity, or pick in /import.`);
  } else if (skipReason === "no_customer_match") {
    console.log(`  ⚠ Would SKIP — reason: no_customer_match`);
    console.log(
      `    Fix: set customer__1 in Monday, or rename the item to start with a known Customer's first word.`,
    );
  } else {
    console.log(`  ? Indeterminate — no resolution and no skip reason set.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

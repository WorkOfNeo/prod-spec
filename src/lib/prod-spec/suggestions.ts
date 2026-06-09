// Suggestion engine for the ProdSpec wizard.
//
// Builds two ordered lists from current state:
//   1. New BusinessArea suggestions  — distinct `__business_area__1` /
//      `status_18__1` values seen in ghost board data that don't yet
//      have a BusinessArea row.
//   2. New ProdSpec suggestions       — (Customer × BusinessArea) pairs
//      with no existing ProdSpec, ranked by how many ghost Style /
//      Pre Order items would map to the pair if it existed.
//
// Customer matching is heuristic: we extract the leading "brand token"
// from each ghost item name (everything up to the first "[" / "(" /
// number / dash) and look for a Customer whose name starts with it. JYSK
// item names like "JYSK [Malte small]" map to every Customer beginning
// with "JYSK" (JYSK A/S, JYSK SE, …), and the wizard surfaces each as a
// separate candidate so the operator picks the right entity.

import { db } from "@/lib/db";
import {
  BLANK_BA_VALUES,
  buildCustomerTokenIndex,
  extractLeadingToken,
  readGhostColumnText,
} from "@/lib/import/heuristics";

// Ghost board ids we scan for BA + customer-name signals. Kept inline
// because the suggestion engine is the only caller; if this list grows
// we'll promote it to boards.ts.
const SCAN_BOARDS = [
  { mondayBoardId: "6979419195", baColumnId: "__business_area__1" }, // Styles
  { mondayBoardId: "7322835224", baColumnId: "status_18__1" }, // Pre Order
] as const;

export type NewBaSuggestion = {
  mondayValue: string;
  // Suggested display name — same as mondayValue for now, operator can
  // override in the standard BA admin if they want a friendlier label.
  name: string;
  // Item count across all scanned boards.
  totalCount: number;
  perBoard: Array<{ mondayBoardId: string; boardLabel: string; count: number }>;
};

export type NewProdSpecSuggestion = {
  customerId: string;
  customerName: string;
  businessAreaId: string;
  businessAreaName: string;
  businessAreaMondayValue: string;
  // How many ghost items would land in this ProdSpec under the current
  // matching heuristic (both customer name AND BA match). Sorted desc —
  // operators eyeball this column to pick what's worth creating first.
  matchCount: number;
  // Items matched by customer-name token alone (regardless of BA). Lets
  // the wizard show "JYSK has 1,169 items — pick a BA for the prod spec"
  // even when none of those items have the BA populated yet.
  customerOnlyCount: number;
  sampleItems: string[];
};

export type SuggestionsPayload = {
  newBusinessAreas: NewBaSuggestion[];
  newProdSpecs: NewProdSpecSuggestion[];
  // Counts shown in the wizard header so the operator knows the scope
  // before stepping through.
  stats: {
    customers: number;
    businessAreas: number;
    existingProdSpecs: number;
    scannedItems: number;
  };
};

export async function computeSuggestions(): Promise<SuggestionsPayload> {
  const [customers, businessAreas, existingProdSpecs, ghostBoardRows] = await Promise.all([
    db.customer.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.businessArea.findMany({
      where: { active: true },
      select: { id: true, mondayValue: true, name: true },
    }),
    db.prodSpec.findMany({
      select: { customerId: true, businessAreaId: true },
    }),
    db.mondayGhostBoard.findMany({
      where: { mondayBoardId: { in: SCAN_BOARDS.map((b) => b.mondayBoardId) } },
      select: { id: true, mondayBoardId: true, name: true, label: true },
    }),
  ]);

  // Lookup helpers.
  const existingProdSpecKeys = new Set(
    existingProdSpecs.map((p) => `${p.customerId}::${p.businessAreaId}`),
  );
  const baByLoweredValue = new Map(
    businessAreas.map((b) => [b.mondayValue.toLowerCase(), b] as const),
  );
  const ghostBoardByMondayId = new Map(
    ghostBoardRows.map((b) => [b.mondayBoardId, b] as const),
  );

  // -----------------------------------------------------
  // Phase 1: distinct BA text values in ghost data, missing from the
  // BusinessArea table. Grouped across both scanned boards.
  // -----------------------------------------------------
  type BaTextCount = { value: string; boardId: string; count: bigint };
  const rawBaRows: BaTextCount[] = [];
  for (const scan of SCAN_BOARDS) {
    const board = ghostBoardByMondayId.get(scan.mondayBoardId);
    if (!board) continue;
    const rows = await db.$queryRaw<Array<{ ba: string; c: bigint }>>`
      SELECT cv->>'text' as ba, count(*)::bigint as c
      FROM monday_ghost_items i, jsonb_array_elements(i."columnValues") cv
      WHERE i."boardId" = ${board.id}
        AND cv->>'id' = ${scan.baColumnId}
        AND cv->>'text' IS NOT NULL
        AND cv->>'text' != ''
      GROUP BY cv->>'text'
    `;
    for (const r of rows) rawBaRows.push({ value: r.ba, boardId: scan.mondayBoardId, count: r.c });
  }

  const newBaMap = new Map<string, NewBaSuggestion>();
  for (const row of rawBaRows) {
    const value = row.value.trim();
    if (BLANK_BA_VALUES.has(value)) continue;
    if (baByLoweredValue.has(value.toLowerCase())) continue;
    let entry = newBaMap.get(value.toLowerCase());
    if (!entry) {
      entry = { mondayValue: value, name: value, totalCount: 0, perBoard: [] };
      newBaMap.set(value.toLowerCase(), entry);
    }
    const board = ghostBoardByMondayId.get(row.boardId);
    const boardLabel = board?.label ?? board?.name ?? row.boardId;
    entry.totalCount += Number(row.count);
    entry.perBoard.push({
      mondayBoardId: row.boardId,
      boardLabel,
      count: Number(row.count),
    });
  }
  const newBusinessAreas = Array.from(newBaMap.values()).sort(
    (a, b) => b.totalCount - a.totalCount,
  );

  // -----------------------------------------------------
  // Phase 2: (Customer × BA) pair scores from ghost data.
  //
  // For each ghost item on the scanned boards, extract:
  //   - leading "customer token" from name → matches Customers starting with it
  //   - BA text → matches a BusinessArea by mondayValue (case-insensitive)
  //              OR by display name (case-insensitive) so freshly-added
  //              BAs and standard "PL/Private Label" both resolve.
  // Increment the (customer, BA) pair's count and stash up to 3 sample
  // item names for context in the wizard.
  // -----------------------------------------------------
  const customerTrieByToken = buildCustomerTokenIndex(customers);
  const baByLoweredName = new Map(
    businessAreas.map((b) => [b.name.toLowerCase(), b] as const),
  );

  type PairAccum = {
    customerId: string;
    customerName: string;
    businessAreaId: string;
    businessAreaName: string;
    businessAreaMondayValue: string;
    matchCount: number;
    customerOnlyCount: number;
    sampleItems: string[];
  };
  const pairs = new Map<string, PairAccum>();
  // Customer-only counts — items where the customer matched but the BA
  // didn't (blank or unknown). We multiply this across each existing BA
  // at the end so the wizard can still suggest "JYSK × PL" / "JYSK × License"
  // when none of JYSK's items carry a BA value yet.
  const customerOnly = new Map<string, { customerId: string; customerName: string; count: number; samples: string[] }>();
  let scannedItems = 0;

  for (const scan of SCAN_BOARDS) {
    const board = ghostBoardByMondayId.get(scan.mondayBoardId);
    if (!board) continue;
    const items = await db.mondayGhostItem.findMany({
      where: { boardId: board.id },
      select: { name: true, columnValues: true },
    });
    for (const item of items) {
      scannedItems++;
      const token = extractLeadingToken(item.name);
      if (!token) continue;
      const matchedCustomers = customerTrieByToken.get(token.toLowerCase()) ?? [];
      if (matchedCustomers.length === 0) continue;

      // Customer-only signal: always recorded if we matched a customer.
      for (const c of matchedCustomers) {
        let co = customerOnly.get(c.id);
        if (!co) {
          co = { customerId: c.id, customerName: c.name, count: 0, samples: [] };
          customerOnly.set(c.id, co);
        }
        co.count++;
        if (co.samples.length < 3) co.samples.push(item.name);
      }

      // (Customer × BA) pair signal: needs a known BA from this item.
      const baText = readGhostColumnText(item.columnValues, scan.baColumnId);
      const ba = baText
        ? (baByLoweredValue.get(baText.toLowerCase()) ??
          baByLoweredName.get(baText.toLowerCase()))
        : undefined;
      if (!ba) continue;
      for (const c of matchedCustomers) {
        const key = `${c.id}::${ba.id}`;
        if (existingProdSpecKeys.has(key)) continue;
        let acc = pairs.get(key);
        if (!acc) {
          acc = {
            customerId: c.id,
            customerName: c.name,
            businessAreaId: ba.id,
            businessAreaName: ba.name,
            businessAreaMondayValue: ba.mondayValue,
            matchCount: 0,
            customerOnlyCount: 0,
            sampleItems: [],
          };
          pairs.set(key, acc);
        }
        acc.matchCount++;
        if (acc.sampleItems.length < 3) acc.sampleItems.push(item.name);
      }
    }
  }

  // For every customer we recognised in the data, propose a ProdSpec
  // against EACH existing BA the customer doesn't already have a
  // ProdSpec for. matchCount stays 0 unless we also saw a BA signal
  // for that pair — customerOnlyCount gives operators the "this
  // customer has data here, pick which BA you mean" prompt.
  for (const co of customerOnly.values()) {
    for (const ba of businessAreas) {
      const key = `${co.customerId}::${ba.id}`;
      if (existingProdSpecKeys.has(key)) continue;
      let acc = pairs.get(key);
      if (!acc) {
        acc = {
          customerId: co.customerId,
          customerName: co.customerName,
          businessAreaId: ba.id,
          businessAreaName: ba.name,
          businessAreaMondayValue: ba.mondayValue,
          matchCount: 0,
          customerOnlyCount: 0,
          sampleItems: co.samples.slice(0, 3),
        };
        pairs.set(key, acc);
      }
      acc.customerOnlyCount = co.count;
    }
  }

  // Ranking: direct (customer + BA) match first, then customer-only
  // signal (any-BA), then alphabetical. Operators stepping through the
  // wizard see the strongest evidence at the top and the soft prompts
  // ("JYSK has 1,169 items — assign to PL?") afterwards.
  const newProdSpecs = Array.from(pairs.values()).sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    if (b.customerOnlyCount !== a.customerOnlyCount)
      return b.customerOnlyCount - a.customerOnlyCount;
    if (a.customerName !== b.customerName) return a.customerName.localeCompare(b.customerName);
    return a.businessAreaName.localeCompare(b.businessAreaName);
  });

  return {
    newBusinessAreas,
    newProdSpecs,
    stats: {
      customers: customers.length,
      businessAreas: businessAreas.length,
      existingProdSpecs: existingProdSpecs.length,
      scannedItems,
    },
  };
}

// Helpers (extractLeadingToken / readGhostColumnText /
// buildCustomerTokenIndex / BLANK_BA_VALUES) now live in
// src/lib/import/heuristics.ts and are shared with the Manual Import flow.

// Single ghost-data pass that powers the /import dashboard, the
// notification-bell counts, and the bulk-accept server endpoint. Built as
// a sibling of src/lib/prod-spec/suggestions.ts — both walk the same
// ghost boards with the same customer-token heuristic, but this one
// emits per-ghost-item candidate rows (needed to promote) on top of the
// new-combination aggregate (needed to surface the dashboard's top card).
//
// Perf notes:
//   - The ghost-item fetch is a raw SQL projection. We do NOT pull the
//     full `columnValues` jsonb (50+ entries per item, multi-MB total on
//     the Pre-Order board) — instead a LATERAL join extracts the three
//     scalars we actually read (BA text, customer-link value, PO text).
//     That's the difference between "a few hundred KB" and "tens of MB"
//     over the wire from Railway to a local dev box.
//   - Boards are queried in parallel via Promise.all.
//   - The function is wrapped in React `cache()` so multiple Suspense
//     boundaries on the same request share one scan.

import { cache } from "react";
import { db } from "@/lib/db";
import { MONDAY_BOARDS, MONDAY_PRE_ORDER_COLS } from "@/lib/monday/boards";
import {
  BLANK_BA_VALUES,
  buildCustomerTokenIndex,
  extractLeadingToken,
  extractLinkedItemId,
  isArchivedGroup,
} from "./heuristics";

// Per-board column ids the scan needs. Customer-link is optional; when
// unset we fall back to the leading-token heuristic.
//
// Source = the Pre-Order board: it is now the source-of-truth for the
// Style entity (carries customer/PO/BA + all product fields), so /import
// scans it to surface promotable ghost items.
type ScanBoard = {
  mondayBoardId: string;
  label: string;
  baColumnId: string;
  customerLinkColumnId: string;
  poNumberColumnId: string;
};

function getScanBoards(): ScanBoard[] {
  return [
    {
      mondayBoardId: MONDAY_BOARDS.preOrder,
      label: "Pre Order",
      baColumnId: MONDAY_PRE_ORDER_COLS.businessArea,
      customerLinkColumnId: MONDAY_PRE_ORDER_COLS.customerLink,
      poNumberColumnId: MONDAY_PRE_ORDER_COLS.poNumber,
    },
  ];
}

// -----------------------------------------------------
// Public shapes
// -----------------------------------------------------

export type CustomerResolution =
  | { kind: "unique"; customerId: string; customerName: string }
  | {
      kind: "ambiguous";
      candidates: Array<{ id: string; name: string }>;
    }
  | { kind: "unmatched"; tokenTried: string | null };

export type BaResolution =
  | { kind: "resolved"; businessAreaId: string; baName: string; baMondayValue: string }
  | { kind: "blank" }
  | { kind: "unknown_text"; text: string };

export type GhostItemImportCandidate = {
  ghostItemId: string; // MondayGhostItem.id (cuid)
  mondayItemId: string;
  mondayBoardId: string;
  boardLabel: string;
  itemName: string;
  groupTitle: string | null;

  customerResolution: CustomerResolution;
  baResolution: BaResolution;
  poNumber: string | null;

  // True when the (resolved customer × resolved BA) pair has a ProdSpec.
  // For ambiguous customer matches, true if ANY candidate has a ProdSpec
  // with the resolved BA — the disambiguation UI narrows the per-row
  // dropdown to candidates that actually have one.
  prodSpecExists: boolean;
  // mondayItemId already in the Style table — excluded from importable.
  alreadyPromoted: boolean;
};

export type NewCombination = {
  customerId: string;
  customerName: string;
  businessAreaId: string;
  businessAreaName: string;
  baMondayValue: string;
  // Items where THIS customer is the unique trie match.
  matchCount: number;
  // Items where this customer was one of several trie matches; doesn't
  // auto-import on Accept (need disambiguation), but useful evidence
  // when ranking which pair to act on first.
  ambiguousCount: number;
  sampleItems: string[];
};

export type ImportScanResult = {
  importable: GhostItemImportCandidate[];
  ambiguous: GhostItemImportCandidate[];
  newCombinations: NewCombination[];
  stats: {
    scannedItems: number;
    alreadyPromoted: number;
    importable: number;
    ambiguous: number;
    newCombinations: number;
    // Funnel breakdown so operators can see WHY a high scan count
    // produces few combos. Each scanned ghost item lands in exactly one
    // of these buckets (alreadyPromoted excluded — it's checked first).
    droppedUnmatchedCustomer: number;
    droppedBlankBa: number;
    droppedUnknownBa: number;
    contributedToCombination: number;
  };
};

// -----------------------------------------------------
// scanForImport — request-cached so multiple Suspense boundaries on the
// /import page share the same scan instead of re-running it three times.
// -----------------------------------------------------

export const scanForImport = cache(async function scanForImport(): Promise<ImportScanResult> {
  const scanBoards = getScanBoards();
  const scanBoardIds = scanBoards.map((b) => b.mondayBoardId);

  const [customers, businessAreas, existingProdSpecs, ghostBoardRows] = await Promise.all([
    db.customer.findMany({
      where: { active: true },
      select: { id: true, name: true, mondayItemId: true },
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
      where: { mondayBoardId: { in: scanBoardIds } },
      select: { id: true, mondayBoardId: true, name: true, label: true },
    }),
  ]);

  const customerTrie = buildCustomerTokenIndex(customers);
  const customerByMondayId = new Map(
    customers.filter((c) => c.mondayItemId).map((c) => [c.mondayItemId as string, c] as const),
  );
  const baByLoweredValue = new Map(
    businessAreas.map((b) => [b.mondayValue.toLowerCase(), b] as const),
  );
  const baByLoweredName = new Map(
    businessAreas.map((b) => [b.name.toLowerCase(), b] as const),
  );
  const existingProdSpecKeys = new Set(
    existingProdSpecs.map((p) => `${p.customerId}::${p.businessAreaId}`),
  );
  const ghostBoardByMondayId = new Map(
    ghostBoardRows.map((b) => [b.mondayBoardId, b] as const),
  );

  // -----------------------------------------------------
  // Pull ghost items per board IN PARALLEL using a projected SQL query.
  //
  // The LATERAL joins evaluate jsonb_array_elements only for the column
  // ids we actually care about, returning scalars (small strings + one
  // small jsonb). Replaces the previous `findMany({ select: { columnValues:
  // true } })` which dragged megabytes of jsonb over the wire for every
  // dashboard hit. Verified pattern matches src/lib/prod-spec/suggestions.ts.
  // -----------------------------------------------------
  type RawRow = {
    id: string;
    monday_item_id: string;
    name: string;
    group_title: string | null;
    ba_text: string | null;
    customer_link_value: unknown;
    po_text: string | null;
  };

  const perBoardRows = await Promise.all(
    scanBoards.map(async (scan) => {
      const board = ghostBoardByMondayId.get(scan.mondayBoardId);
      if (!board) return { scan, rows: [] as RawRow[] };
      const rows = await db.$queryRaw<RawRow[]>`
        SELECT
          i.id,
          i."mondayItemId" AS monday_item_id,
          i.name,
          i."groupTitle" AS group_title,
          ba_cv.text AS ba_text,
          link_cv.value AS customer_link_value,
          po_cv.text AS po_text
        FROM monday_ghost_items i
        LEFT JOIN LATERAL (
          SELECT cv->>'text' AS text
          FROM jsonb_array_elements(i."columnValues") cv
          WHERE cv->>'id' = ${scan.baColumnId}
          LIMIT 1
        ) ba_cv ON true
        LEFT JOIN LATERAL (
          SELECT cv->'value' AS value
          FROM jsonb_array_elements(i."columnValues") cv
          WHERE cv->>'id' = ${scan.customerLinkColumnId}
          LIMIT 1
        ) link_cv ON true
        LEFT JOIN LATERAL (
          SELECT cv->>'text' AS text
          FROM jsonb_array_elements(i."columnValues") cv
          WHERE cv->>'id' = ${scan.poNumberColumnId}
          LIMIT 1
        ) po_cv ON true
        WHERE i."boardId" = ${board.id}
      `;
      return { scan, rows };
    }),
  );

  // Pull the Style.mondayItemId set in one batched query — same
  // strategy as before but on the projected ids only.
  const allMondayItemIds = perBoardRows.flatMap((b) => b.rows.map((r) => r.monday_item_id));
  const promotedRows = allMondayItemIds.length
    ? await db.style.findMany({
        where: { mondayItemId: { in: allMondayItemIds } },
        select: { mondayItemId: true },
      })
    : [];
  const promotedSet = new Set(promotedRows.map((r) => r.mondayItemId));

  // -----------------------------------------------------
  // Resolve each ghost item, bucket it, accumulate combinations.
  // -----------------------------------------------------
  const importable: GhostItemImportCandidate[] = [];
  const ambiguous: GhostItemImportCandidate[] = [];
  const combos = new Map<string, NewCombination>();

  let scannedItems = 0;
  let alreadyPromotedCount = 0;
  let droppedUnmatchedCustomer = 0;
  let droppedBlankBa = 0;
  let droppedUnknownBa = 0;
  let contributedToCombination = 0;

  for (const { scan, rows } of perBoardRows) {
    for (const r of rows) {
      // Skip archived groups ("✅ Done", "Cancelled", "Templates" …)
      // entirely — they shouldn't appear in any bucket, and excluding
      // them keeps the funnel counts honest. Operators reactivate via
      // Monday if they ever want one back.
      if (isArchivedGroup(r.group_title)) continue;

      scannedItems++;
      const alreadyPromoted = promotedSet.has(r.monday_item_id);
      if (alreadyPromoted) alreadyPromotedCount++;

      // ---------- Customer resolution ----------
      const linkedCustomerMondayId = scan.customerLinkColumnId
        ? extractLinkedItemId(r.customer_link_value)
        : null;
      let customerResolution: CustomerResolution;
      if (linkedCustomerMondayId && customerByMondayId.has(linkedCustomerMondayId)) {
        const c = customerByMondayId.get(linkedCustomerMondayId)!;
        customerResolution = { kind: "unique", customerId: c.id, customerName: c.name };
      } else {
        const token = extractLeadingToken(r.name);
        const matches = token ? (customerTrie.get(token.toLowerCase()) ?? []) : [];
        if (matches.length === 0) {
          customerResolution = { kind: "unmatched", tokenTried: token };
        } else if (matches.length === 1) {
          customerResolution = {
            kind: "unique",
            customerId: matches[0].id,
            customerName: matches[0].name,
          };
        } else {
          customerResolution = {
            kind: "ambiguous",
            candidates: matches.map((m) => ({ id: m.id, name: m.name })),
          };
        }
      }

      // ---------- BA resolution ----------
      const baText = r.ba_text?.trim() ?? null;
      let baResolution: BaResolution;
      if (!baText || BLANK_BA_VALUES.has(baText)) {
        baResolution = { kind: "blank" };
      } else {
        const ba =
          baByLoweredValue.get(baText.toLowerCase()) ??
          baByLoweredName.get(baText.toLowerCase());
        baResolution = ba
          ? {
              kind: "resolved",
              businessAreaId: ba.id,
              baName: ba.name,
              baMondayValue: ba.mondayValue,
            }
          : { kind: "unknown_text", text: baText };
      }

      // ---------- PO number ----------
      const poNumber = scan.poNumberColumnId && r.po_text ? r.po_text.trim() || null : null;

      // ---------- ProdSpec-exists ----------
      let prodSpecExists = false;
      if (baResolution.kind === "resolved") {
        const baId = baResolution.businessAreaId;
        if (customerResolution.kind === "unique") {
          prodSpecExists = existingProdSpecKeys.has(`${customerResolution.customerId}::${baId}`);
        } else if (customerResolution.kind === "ambiguous") {
          prodSpecExists = customerResolution.candidates.some((c) =>
            existingProdSpecKeys.has(`${c.id}::${baId}`),
          );
        }
      }

      const candidate: GhostItemImportCandidate = {
        ghostItemId: r.id,
        mondayItemId: r.monday_item_id,
        mondayBoardId: scan.mondayBoardId,
        boardLabel: scan.label,
        itemName: r.name,
        groupTitle: r.group_title,
        customerResolution,
        baResolution,
        poNumber,
        prodSpecExists,
        alreadyPromoted,
      };

      // ---------- Bucket ----------
      if (alreadyPromoted) {
        // Skip.
      } else if (
        baResolution.kind === "resolved" &&
        customerResolution.kind === "unique" &&
        prodSpecExists
      ) {
        importable.push(candidate);
      } else if (
        baResolution.kind === "resolved" &&
        customerResolution.kind === "ambiguous" &&
        prodSpecExists
      ) {
        ambiguous.push(candidate);
      } else if (customerResolution.kind === "unmatched") {
        droppedUnmatchedCustomer++;
      } else if (baResolution.kind === "blank") {
        droppedBlankBa++;
      } else if (baResolution.kind === "unknown_text") {
        droppedUnknownBa++;
      } else if (
        baResolution.kind === "resolved" &&
        !prodSpecExists &&
        (customerResolution.kind === "unique" || customerResolution.kind === "ambiguous")
      ) {
        contributedToCombination++;
        const baId = baResolution.businessAreaId;
        const baName = baResolution.baName;
        const baMondayValue = baResolution.baMondayValue;
        const candidates =
          customerResolution.kind === "unique"
            ? [{ id: customerResolution.customerId, name: customerResolution.customerName }]
            : customerResolution.candidates;
        const isAmbiguous = customerResolution.kind === "ambiguous";
        for (const c of candidates) {
          const key = `${c.id}::${baId}`;
          if (existingProdSpecKeys.has(key)) continue;
          let acc = combos.get(key);
          if (!acc) {
            acc = {
              customerId: c.id,
              customerName: c.name,
              businessAreaId: baId,
              businessAreaName: baName,
              baMondayValue,
              matchCount: 0,
              ambiguousCount: 0,
              sampleItems: [],
            };
            combos.set(key, acc);
          }
          if (isAmbiguous) acc.ambiguousCount++;
          else acc.matchCount++;
          if (acc.sampleItems.length < 3) acc.sampleItems.push(r.name);
        }
      }
    }
  }

  const newCombinations = Array.from(combos.values()).sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    if (b.ambiguousCount !== a.ambiguousCount) return b.ambiguousCount - a.ambiguousCount;
    if (a.customerName !== b.customerName) return a.customerName.localeCompare(b.customerName);
    return a.businessAreaName.localeCompare(b.businessAreaName);
  });

  importable.sort((a, b) => {
    const aName =
      a.customerResolution.kind === "unique" ? a.customerResolution.customerName : "";
    const bName =
      b.customerResolution.kind === "unique" ? b.customerResolution.customerName : "";
    if (aName !== bName) return aName.localeCompare(bName);
    if (a.boardLabel !== b.boardLabel) return a.boardLabel.localeCompare(b.boardLabel);
    return a.itemName.localeCompare(b.itemName);
  });

  ambiguous.sort((a, b) => a.itemName.localeCompare(b.itemName));

  return {
    importable,
    ambiguous,
    newCombinations,
    stats: {
      scannedItems,
      alreadyPromoted: alreadyPromotedCount,
      importable: importable.length,
      ambiguous: ambiguous.length,
      newCombinations: newCombinations.length,
      droppedUnmatchedCustomer,
      droppedBlankBa,
      droppedUnknownBa,
      contributedToCombination,
    },
  };
});

// -----------------------------------------------------
// Helper used by the combinations/accept endpoint: finds the unambiguous,
// not-yet-promoted ghost items matching a specific (customer, BA) pair.
// Re-uses scanForImport so the matching logic stays single-source.
// -----------------------------------------------------
export async function findImportableForPair(
  customerId: string,
  businessAreaId: string,
): Promise<GhostItemImportCandidate[]> {
  const result = await scanForImport();
  return result.importable.filter(
    (c) =>
      c.customerResolution.kind === "unique" &&
      c.customerResolution.customerId === customerId &&
      c.baResolution.kind === "resolved" &&
      c.baResolution.businessAreaId === businessAreaId,
  );
}

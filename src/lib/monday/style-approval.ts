import { MONDAY_BOARDS, MONDAY_STYLE_COLS, MONDAY_STYLE_SUBITEM } from "@/lib/monday/boards";
import {
  changeItemValue,
  findItemByName,
  getSubitems,
  getUsers,
  personIds,
} from "@/lib/monday/client";

// =====================================================
// Monday side of the "style fully approved" chain reaction.
//
// Styles in our DB come from the Pre-Order board, but the operational
// "🛍️ Styles" board (MONDAY_BOARDS.styles) holds the subitems the rest of
// the business tracks. When every ProdSpec output for a style is approved
// we mirror that onto two of those subitems — 01e "Label/Packaging layouts"
// and 01f "Box marking layouts" (the documents ProdSpec produces) — by
// flipping their status to "Approved", and resolve the customer-responsible
// person so the publish step can email them.
//
// WEBHOOK RULE (CLAUDE.md): this module only ever calls changeItemValue()
// to SET a status. It never creates, deletes, or recreates webhooks.
// =====================================================

export type StyleApprovalMondayResult = {
  // An item with this style number exists on the Styles board.
  found: boolean;
  stylesBoardItemId: string | null;
  // Subitem display names whose status was set to Approved.
  subitemsUpdated: string[];
  // Configured codes (e.g. "01e") with no matching subitem on this item.
  subitemsMissing: string[];
  // Per-subitem failures, "code (name): message".
  subitemErrors: string[];
  // Resolved customer-responsible recipients (people column → user emails).
  customerResponsible: Array<{ email: string; name: string | null }>;
  // Human-readable lines for the job Log.
  notes: string[];
};

// Leading code-token of a subitem name: "01e. Label/Packaging layouts" → "01e".
const codeToken = (name: string): string => (name.split(".")[0] ?? "").trim().toLowerCase();

export async function applyStyleApprovalToMonday(
  styleNumber: string,
): Promise<StyleApprovalMondayResult> {
  const result: StyleApprovalMondayResult = {
    found: false,
    stylesBoardItemId: null,
    subitemsUpdated: [],
    subitemsMissing: [],
    subitemErrors: [],
    customerResponsible: [],
    notes: [],
  };

  const item = await findItemByName(MONDAY_BOARDS.styles, styleNumber);
  if (!item) {
    result.notes.push(
      `no item named "${styleNumber}" on the Styles board (${MONDAY_BOARDS.styles}) — subitems not updated`,
    );
    return result;
  }
  result.found = true;
  result.stylesBoardItemId = item.id;

  // 1) Flip the ProdSpec-owned subitems (01e / 01f) to "Approved".
  const { statusCol, approvedLabel, approveCodes } = MONDAY_STYLE_SUBITEM;
  try {
    const subitems = await getSubitems(item.id);
    for (const code of approveCodes) {
      const match = subitems.find((s) => codeToken(s.name) === code);
      if (!match) {
        result.subitemsMissing.push(code);
        continue;
      }
      try {
        await changeItemValue({
          boardId: match.board.id,
          itemId: match.id,
          columnId: statusCol,
          value: JSON.stringify({ label: approvedLabel }),
        });
        result.subitemsUpdated.push(match.name);
      } catch (err) {
        result.subitemErrors.push(`${code} (${match.name}): ${(err as Error).message}`);
      }
    }
  } catch (err) {
    result.subitemErrors.push(`subitem lookup failed: ${(err as Error).message}`);
  }

  // 2) Resolve the customer-responsible person(s) → emails for the notice.
  const col = MONDAY_STYLE_COLS.customerResponsible;
  if (!col) {
    result.notes.push(
      "MONDAY_STYLE_CUSTOMER_RESPONSIBLE_COL not configured — no customer-responsible email",
    );
  } else {
    try {
      const ids = personIds(item, col);
      if (ids.length > 0) {
        const users = await getUsers(ids);
        result.customerResponsible = users
          .filter((u) => u.email)
          .map((u) => ({ email: u.email as string, name: u.name }));
      }
      if (result.customerResponsible.length === 0) {
        result.notes.push(`no customer-responsible email resolved from column "${col}"`);
      }
    } catch (err) {
      result.notes.push(`customer-responsible lookup failed: ${(err as Error).message}`);
    }
  }

  return result;
}

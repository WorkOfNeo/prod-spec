// Shared scan heuristics used by:
//   - src/lib/prod-spec/suggestions.ts (new BA + new ProdSpec wizard)
//   - src/lib/import/scan.ts            (Manual Import dashboard + bell)
//
// Lives outside `prod-spec/` so the import flow doesn't have a circular
// dep on the wizard, and outside `monday/` so the heuristics are clearly
// product-level (customer-name token matching, BA case-insensitive
// resolution) rather than transport-level.

// Status values that mean "blank" in Monday. Filtered out so they don't
// pollute BA suggestions or count as a resolved BA.
export const BLANK_BA_VALUES = new Set(["–", "—", "-", ""]);

// Monday groups that mean "this item is no longer active work" — used
// as a default filter on list views and the /import scan so archived
// items don't drown the operator's signal. Matches case-insensitively
// against substrings of groupTitle:
//   - "done"      / "✅ Done"
//   - "cancel"    / "Cancelled" / "Canceled"
//   - "archived"
//   - "templates" (Pre-Order board uses a "Templates" group for stubs)
// Customers can override by passing showArchived=true on the UI.
export function isArchivedGroup(groupTitle: string | null | undefined): boolean {
  if (!groupTitle) return false;
  const lower = groupTitle.toLowerCase();
  return /done|cancel|archiv|template/.test(lower);
}

// Groups whose styles are NEVER shown on the /styles list — not even via
// "Show archived". Pre-Order "Templates" stubs aren't real styles.
// Hard-excluded at query time (server-side), so these rows never load.
// Narrower than isArchivedGroup on purpose: the softer archived set
// (done/cancelled/archived) stays revealable via the toggle.
// Matched case-insensitively as a substring of groupTitle, same convention
// as isArchivedGroup — so "📋 Templates" is caught too.
//
// TEMP (2026-06-10): "done" removed from this set so the backfilled
// Done-group styles (PO > C-PO63144, see scripts/backfill-preorder-eans.ts)
// are reviewable on /styles behind the "Show archived" toggle. Switch back
// (re-add "done") after the PO-EAN testing window — a couple of days,
// per Niels.
export const HIDDEN_STYLE_GROUP_TERMS = ["template"] as const;

// Map "jysk" → all customers whose first whitespace-separated word is
// "jysk". The matcher looks up the leading token of a ghost item name
// against this map; multiple hits mean "ambiguous, ask the operator".
export function buildCustomerTokenIndex(
  customers: Array<{ id: string; name: string }>,
): Map<string, Array<{ id: string; name: string }>> {
  const m = new Map<string, Array<{ id: string; name: string }>>();
  for (const c of customers) {
    const token = c.name.split(/\s+/)[0]?.trim().toLowerCase();
    if (!token) continue;
    let arr = m.get(token);
    if (!arr) {
      arr = [];
      m.set(token, arr);
    }
    arr.push(c);
  }
  return m;
}

// Take the leading alphanumeric "word" from an item name. Examples:
//   "JYSK [Malte small]"          → "JYSK"
//   "Netto Germany - Style 42"    → "Netto"
//   "A9-1234"                     → "A9"
//   "  GALERIA  Karstadt ..."     → "GALERIA"
// Returns null when nothing usable is found.
export function extractLeadingToken(name: string): string | null {
  const m = name.trim().match(/^([A-Za-z0-9&]+)/);
  return m?.[1] ?? null;
}

// Pull the text value of a column id out of the stored ghost
// `columnValues` JSON array. Defensive against missing/empty entries.
export function readGhostColumnText(columnValues: unknown, columnId: string): string | null {
  if (!Array.isArray(columnValues)) return null;
  for (const cv of columnValues as Array<{ id?: unknown; text?: unknown }>) {
    if (cv && typeof cv === "object" && cv.id === columnId) {
      const t = typeof cv.text === "string" ? cv.text.trim() : "";
      return t || null;
    }
  }
  return null;
}

// Pull a parsed `value` field (already JSON-parsed by the sink) for a
// given column id. Used for board_relation columns where the payload
// shape (`linkedPulseIds: [{ linkedPulseId }]`) lives under `value`, not
// `text`. Returns the raw entry's value or null.
export function readGhostColumnValue(columnValues: unknown, columnId: string): unknown {
  if (!Array.isArray(columnValues)) return null;
  for (const cv of columnValues as Array<{ id?: unknown; value?: unknown }>) {
    if (cv && typeof cv === "object" && cv.id === columnId) {
      return cv.value ?? null;
    }
  }
  return null;
}

// Extract the first linked-pulse id from a Monday board_relation /
// "item connect" column's parsed value. Mirrors the helper in
// src/lib/monday/ingest.ts so the ghost-only promote path doesn't have
// to import the ingest module.
export function extractLinkedItemId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const link = raw as { linkedPulseIds?: Array<{ linkedPulseId?: number | string }> };
  const first = link.linkedPulseIds?.[0]?.linkedPulseId;
  return first != null ? String(first) : null;
}

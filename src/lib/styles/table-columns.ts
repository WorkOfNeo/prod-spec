// Column registry for the /styles table. Single source of truth for what a
// column IS: its key, header label, and canonical position — the render
// order in styles-table.tsx is this array filtered by the visible set, so
// "move a column" means reordering here. Which columns are VISIBLE is an
// admin-controlled global setting (AppSetting "stylesTableColumns", see
// src/lib/settings/app-settings.ts) — the standard view every user gets,
// not a per-user preference.

export type StyleColumnKey =
  | "style"
  | "po"
  | "customer"
  | "businessArea"
  | "group"
  | "generation"
  | "completion"
  | "status"
  | "ean"
  | "lastSynced";

export const STYLE_TABLE_COLUMNS: ReadonlyArray<{
  key: StyleColumnKey;
  label: string;
  // Locked columns can't be hidden — the table needs at least the name link.
  locked?: boolean;
}> = [
  { key: "style", label: "Style", locked: true },
  { key: "po", label: "PO" },
  { key: "customer", label: "Customer" },
  { key: "businessArea", label: "Business area" },
  { key: "group", label: "Group" },
  // Generation sits where Completion used to be; Completion follows it,
  // hidden in the standard view (kept togglable — the % is still stored).
  { key: "generation", label: "Generation" },
  { key: "completion", label: "Completion" },
  { key: "status", label: "Status" },
  { key: "ean", label: "EAN" },
  { key: "lastSynced", label: "Last synced" },
];

// The standard view: everything except Completion.
export const STANDARD_VISIBLE: ReadonlyArray<StyleColumnKey> = [
  "style",
  "po",
  "customer",
  "businessArea",
  "group",
  "generation",
  "status",
  "ean",
  "lastSynced",
];

const KNOWN_KEYS = new Set<string>(STYLE_TABLE_COLUMNS.map((c) => c.key));

// Sanitize a stored / user-supplied value: drop unknown keys (forward compat
// when columns are renamed or added later), force locked columns on, and
// return canonical order. Anything that isn't an array — missing AppSetting
// row, legacy shape — falls back to the standard view.
export function normalizeVisibleColumns(raw: unknown): StyleColumnKey[] {
  if (!Array.isArray(raw)) return [...STANDARD_VISIBLE];
  const wanted = new Set<string>(raw.filter((k): k is string => typeof k === "string" && KNOWN_KEYS.has(k)));
  for (const col of STYLE_TABLE_COLUMNS) {
    if (col.locked) wanted.add(col.key);
  }
  return STYLE_TABLE_COLUMNS.filter((c) => wanted.has(c.key)).map((c) => c.key);
}

// =====================================================
// Trim concepts — the shared vocabulary that lets a Monday "Trims" entry and an
// Output Builder layout recognise each other. On the settings screens these are
// called the cover page's PACKAGING ROWS, because that is what one of them is:
// one line on the cover.
//
// WHY A CONCEPT LAYER AT ALL. The obvious design is to map each Monday trim
// label to the layout that satisfies it. That does not survive contact with the
// catalogue: layouts are named "<Customer> - <Business area> - <Document>", so
// "Care Label" exists ~30 times over, once per customer. Mapping a trim to one
// of them would have to be redone per customer, and again for every customer we
// take on — the mapping would never be finished.
//
// So both sides are classified onto a concept instead:
//
//   Monday  "Wash Care Label with Oeko-tex Logo"  ─┐
//                                                  ├─→ CARE_LABEL
//   Layout  "Coop DK - Private Label - Care Label" ─┘
//
// A style then satisfies a trim when ANY output it declares carries the same
// concept. "Hangtag" is app-generated for a customer that has a hangtag layout
// and manually supplied for one that doesn't, with no per-customer setup — the
// answer falls out of what the style already declares.
//
// THE ROW MUST NOT BECOME PER-CUSTOMER. That is the one property this whole
// file exists to protect, and it is the reason the catalogue is one flat global
// list with no customer column anywhere in it. A "Care Label" row per customer
// is the layout mapping again, wearing a different hat.
//
// WHY `artwork` IS ON THE CONCEPT. A large share of live trims are physical
// packing instructions with no file behind them (Master Polybag alone is on
// 1,733 styles; also hangers, cartons, hooks). Printing those with a delivery
// status would park them at "Waiting for Customer Information" forever and bury
// the rows that genuinely are waiting. They get listed — so the cover matches
// the Monday list one-to-one — but as a note, never as a pending document.
//
// WHY THE WORDING IS ON THE CONCEPT TOO. Same argument, one level down. "Wash
// Care Label, these are created to be printed on one paper, front and back" is
// true of every care label this app has ever produced, for every customer, on
// every PO, because it describes how the artwork is built. Said once against
// CARE_LABEL it prints wherever a care label prints; typed into a per-customer
// cover block it would have to be typed ~30 times and would drift the first
// time one of them was edited.
//
// -----------------------------------------------------------------------------
// THE CATALOGUE IS DATA, AND THIS FILE IS THE SEED FOR IT.
//
// DEFAULT_TRIM_CONCEPTS below used to BE the catalogue. It is now the seed the
// trim_concept_rows table is created from, and the fallback when that table is
// empty or unreachable. A person adds rows at /settings/cover-page?tab=packaging;
// the built-in rows appear in the same list and are edited the same way, so
// nothing is special-cased and day one prints exactly what it printed yesterday.
//
// Reads of the catalogue are SYNCHRONOUS (conceptHasArtwork is called from
// inside the pure manifest assembler, which must stay pure and cheap), so the
// table is loaded into a process-local registry by an async entry point and read
// from there — the same loading model as ensureLayoutVariantsLoaded. The entry
// point is loadTrimConceptRows in ./catalogue, called by loadTrimSettings, which
// every render, sweep and census path already goes through. A path that somehow
// skips it falls back to the seed, which is the pre-table behaviour: safe, not
// silently wrong.
//
// CLIENT-SAFE: no db, no server imports. The settings editors render from this
// shape and the render/readiness chain classifies through it.
// =====================================================

export type TrimConcept = {
  value: string;
  label: string;
  // false ⇒ a physical packing instruction, not a document. Never gets a
  // delivery status; never counts as a missing artwork.
  artwork: boolean;
  // What the cover SAYS about this kind of packaging. `note` is a standing fact
  // and prints in every state; the two statuses are the Status column's wording
  // before and after the artwork is confirmed, and are meaningless — therefore
  // absent — on an artwork:false row. Empty/absent ⇒ the house default
  // (see ./concept-copy).
  note?: string;
  pending?: string;
  delivered?: string;
};

// One row as the table stores it: a concept plus the three columns that are
// about administering the list rather than about what the cover prints.
export type TrimConceptRow = TrimConcept & {
  sortOrder: number;
  // Seeded from the list below rather than added by a person. Advisory only —
  // the editor warns before deactivating one; no behaviour branches on it.
  builtIn: boolean;
  // Deactivated rows are hidden from the pickers but STILL RESOLVE, so a
  // mapping or a layout pin that still names one keeps its label, its artwork
  // flag and its wording instead of degrading to a title-cased id.
  active: boolean;
};

// The seed catalogue. Values are stable ids (stored in the per-label mapping and
// the per-layout pins); labels are what the settings UI and the cover print.
export const DEFAULT_TRIM_CONCEPTS: TrimConcept[] = [
  {
    value: "CARE_LABEL",
    label: "Care label",
    artwork: true,
    note: "Wash Care Label, these are created to be printed on one paper, front and back",
  },
  { value: "CARTON_MARKING", label: "Carton marking", artwork: true },
  { value: "COLOUR_STICKER", label: "Colour sticker", artwork: true },
  { value: "HANGTAG", label: "Hangtag", artwork: true },
  {
    value: "BANDEROLE",
    label: "Banderole",
    artwork: true,
    // A banderole cannot be drawn until the supplier photographs the samples,
    // so "Waiting for Customer Information" points at the wrong party.
    pending: "Awaiting Photo Samples from the supplier.",
  },
  { value: "NECK_PRINT", label: "Neck print", artwork: true },
  { value: "MAIN_LABEL", label: "Main label", artwork: true },
  { value: "SIZE_LABEL", label: "Size label", artwork: true },
  { value: "PRICE_STICKER", label: "Price sticker", artwork: true },
  { value: "BARCODE_STICKER", label: "Barcode sticker", artwork: true },
  { value: "POLYBAG_STICKER", label: "Polybag sticker", artwork: true },
  { value: "INFO_AREA", label: "Info area / insert card", artwork: true },
  { value: "TOPCARD", label: "Top card / header card", artwork: true },
  { value: "PICTOGRAM", label: "Pictogram sticker", artwork: true },
  { value: "HEAT_TRANSFER", label: "Heat transfer", artwork: true },
  { value: "RFID", label: "RFID / security label", artwork: true },
  { value: "POLYBAG", label: "Polybag", artwork: false },
  { value: "HANGER", label: "Hanger", artwork: false },
  { value: "BOX", label: "Carton / box / display", artwork: false },
  { value: "HOOK", label: "Hook / string / loop", artwork: false },
  { value: "PACKING_NOTE", label: "Packing instruction", artwork: false },
];

// The seed as ROWS, in the order and with the sort keys the creating migration
// inserts. Kept next to the list it derives from so the two cannot drift: the
// migration's INSERT is this array, and the loader's fallback is this array.
export const DEFAULT_TRIM_CONCEPT_ROWS: TrimConceptRow[] = DEFAULT_TRIM_CONCEPTS.map(
  (c, i) => ({ ...c, sortOrder: (i + 1) * 10, builtIn: true, active: true }),
);

// ---------------------------------------------------------------------------
// The process-local registry. Seeded with the constant above, replaced once the
// table has been read. See the header for why reads are synchronous.
// ---------------------------------------------------------------------------

let catalogue: TrimConcept[] = DEFAULT_TRIM_CONCEPTS;
let byValue = new Map(catalogue.map((c) => [c.value, c]));

// Install a loaded catalogue. Pass EVERY row, active or not: an inactive row is
// hidden from the pickers by the caller, but still has to resolve for anything
// that already points at it.
//
// An EMPTY list is refused and leaves the seed in place. An empty table is far
// more likely to be a migration that has not run than a person who deleted
// every row (the editor deactivates, it does not delete), and honouring it would
// turn every concept in the book unknown at once.
export function setTrimConceptCatalogue(rows: ReadonlyArray<TrimConcept>): void {
  const next = rows.filter((r) => typeof r?.value === "string" && r.value.trim() !== "");
  if (next.length === 0) return;
  catalogue = next.map((r) => ({ ...r, value: r.value.trim() }));
  byValue = new Map(catalogue.map((c) => [c.value, c]));
}

// Back to the seed. Only tests and the loader's failure path need this.
export function resetTrimConceptCatalogue(): void {
  catalogue = DEFAULT_TRIM_CONCEPTS;
  byValue = new Map(catalogue.map((c) => [c.value, c]));
}

// The catalogue as currently loaded, in display order.
export function trimConceptCatalogue(): TrimConcept[] {
  return catalogue;
}

export function trimConcept(value: string): TrimConcept | null {
  return byValue.get(value) ?? null;
}

// Human label for any concept value, including one that has dropped out of the
// catalogue (a mapping outliving an edit) — title-cased so the UI and the cover
// never print a raw SCREAMING_SNAKE id.
export function trimConceptLabel(value: string): string {
  const known = byValue.get(value);
  if (known) return known.label;
  return value
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Unknown concepts default to artwork:true — the safe direction. Treating a
// real document as a packing note would silently drop it from the manifest,
// which is the exact failure this whole feature exists to fix; treating a note
// as a document merely shows one extra pending row until it's mapped.
export function conceptHasArtwork(value: string): boolean {
  return byValue.get(value)?.artwork ?? true;
}

// ---------------------------------------------------------------------------
// Adding a row.
//
// The value is derived from the label ONCE, when the row is created, and never
// rewritten afterwards — a mapping stored against CARE_LABEL must survive the
// label being changed to "Wash care label". Rows are not deleted for the same
// reason (see TrimConceptRow.active).
// ---------------------------------------------------------------------------

// "Inlay card / insert" -> "INLAY_CARD_INSERT". Leading digits are prefixed
// because a value is also a JSON object key in the stored mappings and reading
// "12_PACK" as a number somewhere downstream is a trap not worth leaving.
export function trimConceptValueFromLabel(label: string): string {
  const base = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "";
  return /^[0-9]/.test(base) ? `ROW_${base}` : base;
}

// The same, made unique against values already in use. Collisions are real —
// "Top card" and "Top-card" derive the same value — and silently merging two
// rows a person meant to keep apart would remap every trim on one of them.
export function uniqueTrimConceptValue(label: string, taken: ReadonlySet<string>): string {
  const base = trimConceptValueFromLabel(label);
  if (!base) return "";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Shape-validating a set of rows on the way IN — from the settings editor, or
// from a hand-rolled PUT. Pure, so the guarantee below is unit-testable without
// a database.
//
// This is guard #1 of the artwork:false rule (see ./concept-copy for all three):
// a row with no artwork loses its status columns HERE, before storage, so no
// later reader has to remember the rule and no row can sit in the table
// carrying wording it must never print.
//
// Rows with no value or no label are dropped rather than stored: neither can be
// displayed, and a value-less row could never be mapped to anything.
// Duplicates keep the FIRST occurrence — the editor sends the list in display
// order, and silently keeping the last would make an accidental duplicate
// overwrite the row a person was actually editing.
// ---------------------------------------------------------------------------
export function normalizeTrimConceptRows(
  rows: ReadonlyArray<Partial<TrimConceptRow>>,
): TrimConceptRow[] {
  const out: TrimConceptRow[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    const label = typeof row?.label === "string" ? row.label.trim() : "";
    if (!value || !label || seen.has(value)) return;
    seen.add(value);
    const artwork = row.artwork !== false;
    const text = (v: unknown): string | undefined => {
      const s = typeof v === "string" ? v.trim() : "";
      return s === "" ? undefined : s;
    };
    out.push({
      value,
      label,
      artwork,
      ...(text(row.note) ? { note: text(row.note) } : {}),
      // Stripped, not merely hidden: a packing instruction has no delivery
      // state, so it must not be able to carry wording describing one.
      ...(artwork && text(row.pending) ? { pending: text(row.pending) } : {}),
      ...(artwork && text(row.delivered) ? { delivered: text(row.delivered) } : {}),
      sortOrder: Number.isFinite(row.sortOrder) ? Number(row.sortOrder) : (i + 1) * 10,
      builtIn: row.builtIn === true,
      active: row.active !== false,
    });
  });
  return out;
}

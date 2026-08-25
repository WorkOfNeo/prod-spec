// =====================================================
// Trim concepts — the shared vocabulary that lets a Monday "Trims" entry and an
// Output Builder layout recognise each other.
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
// WHY `artwork` IS ON THE CONCEPT. A large share of live trims are physical
// packing instructions with no file behind them (Master Polybag alone is on
// 1,733 styles; also hangers, cartons, hooks). Printing those with a delivery
// status would park them at "Waiting for Customer Information" forever and bury
// the rows that genuinely are waiting. They get listed — so the cover matches
// the Monday list one-to-one — but as a note, never as a pending document.
//
// CLIENT-SAFE: no db, no server imports. The settings editor renders from this
// list and the render/readiness chain classifies through it.
// =====================================================

export type TrimConcept = {
  value: string;
  label: string;
  // false ⇒ a physical packing instruction, not a document. Never gets a
  // delivery status; never counts as a missing artwork.
  artwork: boolean;
};

// The seed catalogue. Values are stable ids (stored in the rule table and in
// per-label overrides); labels are what the settings UI and the cover print.
export const DEFAULT_TRIM_CONCEPTS: TrimConcept[] = [
  { value: "CARE_LABEL", label: "Care label", artwork: true },
  { value: "CARTON_MARKING", label: "Carton marking", artwork: true },
  { value: "COLOUR_STICKER", label: "Colour sticker", artwork: true },
  { value: "HANGTAG", label: "Hangtag", artwork: true },
  { value: "BANDEROLE", label: "Banderole", artwork: true },
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

const BY_VALUE = new Map(DEFAULT_TRIM_CONCEPTS.map((c) => [c.value, c]));

export function trimConcept(value: string): TrimConcept | null {
  return BY_VALUE.get(value) ?? null;
}

// Human label for any concept value, including one that has dropped out of the
// catalogue (a stored override outliving an edit) — title-cased so the UI and
// the cover never print a raw SCREAMING_SNAKE id.
export function trimConceptLabel(value: string): string {
  const known = BY_VALUE.get(value);
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
  return BY_VALUE.get(value)?.artwork ?? true;
}

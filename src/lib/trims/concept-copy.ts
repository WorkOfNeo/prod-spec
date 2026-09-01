// =====================================================
// What the cover SAYS about a trim, keyed by CONCEPT.
//
// Three supplier-facing strings per concept, all editable at
// /settings/cover-page:
//
//   note      — a standing fact about what this kind of document IS. "Wash Care
//               Label, these are created to be printed on one paper, front and
//               back" is true of every care label this app has ever produced,
//               for every customer, on every PO, because it describes how the
//               artwork is built. Not a status: it prints in every state.
//   pending   — the status wording while the artwork has not been delivered.
//               "Waiting for Customer Information" almost everywhere; a
//               banderole cannot be designed until the supplier sends photos of
//               the samples, so it says "Awaiting Photo Samples from the
//               supplier." and the supplier knows the ball is in their court.
//   delivered — the status wording once the artwork is confirmed.
//
// WHY IT HANGS OFF THE CONCEPT. The obvious home for these is the per-customer
// cover text block. That does not scale, for exactly the reason the concept
// layer exists at all (see concepts.ts): "Care Label" is a different layout for
// each customer, so a sentence about care labels would have to be typed into
// ~30 cover blocks, retyped for every customer taken on afterwards, and would
// drift out of step the first time one of them was edited. Said once against
// CARE_LABEL, it prints wherever a care label prints, forever.
//
// WHY IT IS DATA AND NOT AN `if`. The banderole rule is a stored default, not a
// branch in the renderer. The next special case — and there is always a next
// one — is then a settings edit rather than a deploy.
//
// artwork:false CONCEPTS NEVER GET A STATUS. A polybag, a hanger, a carton, a
// hook is a physical packing instruction with no file behind it (Master Polybag
// alone is on 1,733 styles). Giving one a delivered/not-delivered state would
// park it at "waiting" forever and bury the rows that genuinely are waiting, so
// the status strings are stripped for those concepts HERE, where copy is
// normalised — not merely hidden by the editor that writes it. They keep
// printing as a note with no status. See conceptHasArtwork.
//
// CLIENT-SAFE: pure, no db, no server imports.
// =====================================================

import { conceptHasArtwork } from "./concepts";

// The wording used when a concept says nothing of its own. These are the
// sentences covers have always printed, so an unconfigured estate reads exactly
// as it did before any of this existed.
export const DEFAULT_PENDING_STATUS = "Waiting for Customer Information";
export const DEFAULT_DELIVERED_STATUS = "Approved";

export type TrimConceptCopy = {
  // Plain text (escaped at render), not markdown — one line under the row.
  note?: string;
  // Status wording. Meaningless, and therefore removed, on an artwork:false
  // concept. An empty string is a real, storable decision: "no wording of your
  // own", i.e. fall back to the default above. That is how a seeded default
  // like the banderole's is cleared again.
  pending?: string;
  delivered?: string;
};

export type TrimConceptCopyMap = Readonly<Record<string, TrimConceptCopy>>;

// The seed copy. Keyed by TrimConcept.value. Everything absent here falls to
// the defaults above (statuses) or prints nothing (note).
export const DEFAULT_TRIM_CONCEPT_COPY: TrimConceptCopyMap = {
  CARE_LABEL: {
    note: "Wash Care Label, these are created to be printed on one paper, front and back",
  },
  BANDEROLE: {
    // A banderole cannot be drawn until the supplier photographs the samples,
    // so "Waiting for Customer Information" points at the wrong party.
    pending: "Awaiting Photo Samples from the supplier.",
  },
};

const FIELDS = ["note", "pending", "delivered"] as const;

// Shape-validate a stored blob. Unknown keys and non-strings are dropped;
// EMPTY STRINGS SURVIVE, because "" is the stored form of "cleared, use the
// default" and losing it would resurrect a seeded default the user removed.
export function normalizeConceptCopy(raw: unknown): TrimConceptCopyMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TrimConceptCopy> = {};
  for (const [concept, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!concept.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry: TrimConceptCopy = {};
    const allowStatus = conceptHasArtwork(concept);
    for (const field of FIELDS) {
      const v = (value as Record<string, unknown>)[field];
      if (typeof v !== "string") continue;
      // A packing instruction has no delivery state to describe. Dropped at the
      // point of storage so no later reader has to remember the rule.
      if (!allowStatus && field !== "note") continue;
      entry[field] = v.trim();
    }
    if (Object.keys(entry).length > 0) out[concept.trim()] = entry;
  }
  return out;
}

// The map the render chain actually uses: the seed, with anything stored laid
// over it field by field. Per-field rather than per-concept, so setting a
// banderole note does not silently drop its seeded pending wording.
export function effectiveConceptCopy(stored: unknown): TrimConceptCopyMap {
  const overrides = normalizeConceptCopy(stored);
  const out: Record<string, TrimConceptCopy> = {};
  for (const concept of new Set([
    ...Object.keys(DEFAULT_TRIM_CONCEPT_COPY),
    ...Object.keys(overrides),
  ])) {
    out[concept] = { ...DEFAULT_TRIM_CONCEPT_COPY[concept], ...overrides[concept] };
  }
  return out;
}

// The copy that applies to ONE manifest row, given the concepts that row
// resolves to (a compound Monday entry names several).
//
// Returns undefined rather than an empty object when nothing applies, so a row
// with no copy carries no field at all — the manifest fingerprint then stays
// byte-identical to what it was before this existed, and an estate whose covers
// gain nothing is not swept into a rebuild.
export type ResolvedTrimCopy = {
  note?: string;
  pending?: string;
  delivered?: string;
};

export function resolveTrimCopy(
  concepts: ReadonlyArray<string>,
  map: TrimConceptCopyMap = DEFAULT_TRIM_CONCEPT_COPY,
  opts?: {
    // false for a row with no delivery state — a packing instruction. The
    // second guard on the artwork:false rule, at the row rather than the
    // concept, so a compound entry that names a real document alongside a
    // polybag still cannot borrow a status from the polybag.
    allowStatus?: boolean;
  },
): ResolvedTrimCopy | undefined {
  const allowStatus = opts?.allowStatus !== false;
  // Fixed key order, so two runs over the same input serialise identically into
  // the manifest fingerprint.
  const resolved: ResolvedTrimCopy = {};
  for (const field of FIELDS) {
    if (field !== "note" && !allowStatus) continue;
    for (const concept of concepts) {
      // Statuses only ever come from a concept that HAS artwork; a note can
      // come from any of them.
      if (field !== "note" && !conceptHasArtwork(concept)) continue;
      const value = map[concept]?.[field]?.trim();
      // First concept with something to say wins, per field — a compound entry
      // is one row and can only print one of each.
      if (value) {
        resolved[field] = value;
        break;
      }
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

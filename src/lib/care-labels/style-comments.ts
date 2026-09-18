// =====================================================
// Care instructions supplied by the CUSTOMER in Monday's "Style Comments"
// field, rather than resolved from the care-label catalogue + translation
// bank. Backs {{careInstructions:salling}}.
//
// Salling receive their care wording directly from the customer, so the
// standard catalogue path (wash-icon-filtered phrases, translated per
// language) is wrong for them — there is nothing to translate and nothing to
// select. The wording is typed into the Styles board's Style Comments column
// under a "TEXT ON LABEL:" heading, and only that block belongs on a label.
//
// THE PREFIX IS A GATE, NOT DECORATION. Style Comments is a general-purpose
// production-notes field: of the ~2,000 styles carrying one, the vast
// majority are internal chatter ("Info Area: Yes.", "Customer requires
// mock-up for print before production"). Printing an unprefixed comment would
// put that chatter on a care label, so a value without the heading resolves
// to "" and the slot prints empty.
//
// Pure string logic, no DB — safe to import from client components (the admin
// preview panel) as well as the server renderers, like ./format.
// =====================================================

import { capitalizeCarePhrase } from "./format";

// The heading that marks the rest of the cell as label copy. Matched at the
// START of the value only, case-insensitively, tolerating whitespace around
// the colon — live data carries both "TEXT ON LABEL:\n" and "TEXT ON LABEL: \n".
const LABEL_TEXT_PREFIX = /^\s*TEXT\s+ON\s+LABEL\s*:/i;

// One instruction per line. Buyers separate them by newline (how the field is
// actually filled) or by comma (how it reads when Monday collapses the cell to
// a single grid row). Neither separator occurs inside a real care phrase in
// the live data, so splitting on both is safe and matches how the wording is
// dictated. A bare "/" is deliberately NOT a separator — "inside/out" is one
// instruction, the same reasoning as CARE_SPLIT in ./format.
const INSTRUCTION_SPLIT = /[\r\n,]+/;

// Extract the printable care instructions from one raw Style Comments value.
// Returns "" when the value is missing, blank, or not marked as label copy.
//
// Returns the instructions joined by NEWLINES, one per line — the renderer's
// .ol-line is `white-space: pre-wrap`, so the token drops straight into a
// block as separate lines (the same shape formatCompositionLines emits).
// Deliberately NOT routed through sanitizeCareInstructions: that splits on
// newlines and rejoins with " / ", which would collapse the lines back into a
// single run. Each phrase still gets the house capitalization rule applied.
export function parseStyleCommentCareInstructions(raw: string | null | undefined): string {
  if (!raw) return "";
  if (!LABEL_TEXT_PREFIX.test(raw)) return "";

  return raw
    .replace(LABEL_TEXT_PREFIX, "")
    .split(INSTRUCTION_SPLIT)
    .map(capitalizeCarePhrase)
    .filter(Boolean)
    .join("\n");
}

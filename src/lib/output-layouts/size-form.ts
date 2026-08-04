// =====================================================
// Two-form size labels — "86-92 cm / 1½-2 år".
//
// Kids' size runs are often filled with BOTH forms in one label, the
// measurement and the age, separated by a slash:
//
//   "86-92 cm / 1½-2 år, 98-104 cm / 3-4 år, 110-116 cm / 5-6 år, …"
//
// Which one a printed label shows is a per-output decision — one customer's
// price tag prints the centimetres, another's prints the age. This module is
// the pure picker behind the token argument that makes that choice
// ({{sizeRangeCoop:numeric}} / {{sizeRangeCoop:year}}).
//
// The split is by the AGE UNIT, never by the slash alone: plenty of size
// labels are themselves slash-joined numbers ("86/92", "23/26"), and those
// must survive untouched. A label with no age half is not a two-form label —
// it prints verbatim for either form, the same "never blank a printed field"
// contract size-scoped-text.ts follows.
// =====================================================

// The two halves a size label can carry. "numeric" is the measurement
// ("86-92 cm"), "year" the age ("1½-2 år" — months count as an age too).
export const SIZE_FORMS = ["numeric", "year"] as const;
export type SizeForm = (typeof SIZE_FORMS)[number];

// Age units seen in the size columns — Danish/Swedish/Norwegian "år" (and
// its ASCII spellings), English years/months, German Jahre, Danish "mdr".
// Deliberately no single-letter units: a bare "m" or "y" is as likely to be
// a size (M) or a stray character as a unit.
const AGE_UNIT_RE =
  /(?<![\p{L}])(år|aar|ar|year|years|yr|yrs|jahr|jahre|mdr|mdr\.|måned|maaned|måneder|maaneder|month|months|mth|mths)(?![\p{L}])/iu;

// Does this slash-separated part carry an age unit ("1½-2 år", "3-6 mdr")?
export function isAgePart(part: string): boolean {
  return AGE_UNIT_RE.test(part);
}

// The requested half of a size label, or the label verbatim when it doesn't
// carry that split. Parts are regrouped with "/" so a slash-joined
// measurement ("86 / 92 cm / 1½-2 år" → "86 / 92 cm") keeps its shape.
export function pickSizeForm(label: string, form: SizeForm | null): string {
  if (!form) return label;
  const parts = label.split("/");
  const age = parts.filter(isAgePart);
  // No age half ⇒ not a two-form label. Print it as authored for BOTH forms
  // rather than blanking the field: a run given only in centimetres is still
  // the answer to "which sizes does this style come in".
  if (age.length === 0) return label;
  if (form === "year") return age.join("/").trim() || label;
  const numeric = parts.filter((p) => !isAgePart(p));
  return numeric.join("/").trim() || label;
}

// One printed entry of a size run: the text to show and the raw label(s) it
// came from (several labels can collapse into one entry — two age ranges
// sharing a measurement, say — and the caller still needs to know whether
// the current repetition's size is among them).
export type SizeFormEntry = { text: string; labels: string[] };

// A size run reduced to the requested form: each label narrowed, then
// consecutive duplicates of the SAME text collapsed so a run doesn't print
// "86-92 cm - 86-92 cm". With no form (bare token) this is a plain 1:1
// passthrough — no narrowing, no collapsing — so an existing layout prints
// exactly what it printed before.
export function sizeFormEntries(
  labels: readonly string[],
  form: SizeForm | null,
): SizeFormEntry[] {
  if (!form) return labels.map((label) => ({ text: label, labels: [label] }));
  const out: SizeFormEntry[] = [];
  const byText = new Map<string, SizeFormEntry>();
  for (const label of labels) {
    const text = pickSizeForm(label, form);
    const seen = byText.get(text);
    if (seen) {
      seen.labels.push(label);
      continue;
    }
    const entry: SizeFormEntry = { text, labels: [label] };
    byText.set(text, entry);
    out.push(entry);
  }
  return out;
}

// The token argument as a form, or null for "no argument" / anything else
// (validateTokenRef is what rejects a bad one at publish time; a stray value
// must never blank a printed range).
export function parseSizeForm(arg: string | undefined): SizeForm | null {
  return arg && (SIZE_FORMS as readonly string[]).includes(arg) ? (arg as SizeForm) : null;
}

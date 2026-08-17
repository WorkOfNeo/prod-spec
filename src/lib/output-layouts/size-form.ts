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
// ({{sizeRangeCoop:numeric}} / {{sizeRangeCoop:year}}), plus the way that
// choice is SET as one printed run (see sizeFormRun).
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
const AGE_UNITS = [
  "år",
  "aar",
  "ar",
  "year",
  "years",
  "yr",
  "yrs",
  "jahr",
  "jahre",
  "mdr",
  "måned",
  "maaned",
  "måneder",
  "maaneder",
  "month",
  "months",
  "mth",
  "mths",
];

// Every unit a size label can end in — the ages above plus the measurement
// units. Longest first so "years" wins over "year" in an alternation.
const ALL_UNITS = [...AGE_UNITS, "cm", "mm"].sort((a, b) => b.length - a.length);
const UNIT_ALT = ALL_UNITS.join("|");

const AGE_UNIT_RE = new RegExp(`(?<![\\p{L}])(${AGE_UNITS.join("|")})\\.?(?![\\p{L}])`, "iu");

// A unit sitting at the END of a label half — "98-104 cm" → "98-104" + "cm".
// The leading group is greedy and must end on a non-letter, so "104cm" splits
// but a bare "år" (no value in front of it) doesn't.
const UNIT_TAIL_RE = new RegExp(`^(.*[^\\p{L}])(${UNIT_ALT})\\.?\\s*$`, "iu");

// A unit ANYWHERE in the text — the guard that stops a half carrying two of
// them ("1½-2 år / 18-24 mdr") from being compacted into nonsense.
const UNIT_ANY_RE = new RegExp(`(?<![\\p{L}])(${UNIT_ALT})\\.?(?![\\p{L}])`, "iu");

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

// One picked half taken apart: the bare numbers and the unit they were
// written in. "98-104 cm" → { value: "98/104", unit: "cm" }.
//
// The value is COMPACTED on the way out — the range separator inside one
// size becomes a slash, so the run's own "-" joiner can't be mistaken for it
// ("98/104-110/116" reads as two sizes, "98-104-110-116" reads as four).
//
// A half that still carries a unit after the trailing one is taken off (two
// age forms slash-joined, say) is left exactly as authored with no unit at
// all: better an odd-looking label than a mangled one.
export function splitSizeUnit(half: string): { value: string; unit: string } {
  const text = half.trim().replace(/\s+/g, " ");
  const m = UNIT_TAIL_RE.exec(text);
  if (!m) return { value: compactSizeValue(text), unit: "" };
  const value = m[1].trim();
  if (!value || UNIT_ANY_RE.test(value)) return { value: text, unit: "" };
  return { value: compactSizeValue(value), unit: m[2] };
}

// "98-104" → "98/104"; "86 / 92" → "86/92"; "98" → "98". Dashes (ASCII and
// the typographic ones) and slashes are all treated as the same internal
// separator, so however the buyer wrote the pair it prints one way.
function compactSizeValue(value: string): string {
  const parts = value.split(/\s*[-–—/]\s*/).filter(Boolean);
  return parts.length > 0 ? parts.join("/") : value;
}

// One printed entry of a size run: the text to show and the raw label(s) it
// came from (several labels can collapse into one entry — two age ranges
// sharing a measurement, say — and the caller still needs to know whether
// the current repetition's size is among them).
export type SizeFormEntry = { text: string; labels: string[] };

// A whole size run, ready to print: the entries, the string that joins them
// and the unit printed ONCE at the end ("" when there isn't a shared one).
export type SizeFormRun = { entries: SizeFormEntry[]; joiner: string; unit: string };

// A size run reduced to the requested form:
//
//   ["98-104 cm / 3-4 år", "110-116 cm / 5-6 år", "122-128 cm / 7-8 år"]
//     :numeric → 98/104-110/116-122/128 cm
//     :year    → 3/4-5/6-7/8 år
//
// Each label is narrowed to the chosen half, the half is split into numbers
// and unit, and the unit is hoisted to the end of the run — the printed form
// the size runs are read in, where repeating "cm" five times is noise. Entries
// that narrow to the SAME text collapse, so a run doesn't print "98/104-98/104".
//
// The unit is only hoisted when the run agrees on one (labels carrying none at
// all don't count against that — a run with one unitless entry still reads
// "…-122/128 cm"). A run that genuinely mixes units — months and years in the
// same column — keeps each unit inline instead, because a single trailing one
// would be a lie.
//
// With no form (bare token) this is a plain 1:1 passthrough joined " - " — no
// narrowing, no compacting, no collapsing — so an existing layout prints
// exactly what it printed before.
export function sizeFormRun(labels: readonly string[], form: SizeForm | null): SizeFormRun {
  if (!form) {
    return {
      entries: labels.map((label) => ({ text: label, labels: [label] })),
      joiner: " - ",
      unit: "",
    };
  }

  const split = labels.map((label) => ({ label, ...splitSizeUnit(pickSizeForm(label, form)) }));
  const units = [...new Set(split.map((s) => s.unit).filter(Boolean).map((u) => u.toLowerCase()))];
  const hoist = units.length === 1;
  const unit = hoist ? split.find((s) => s.unit)?.unit ?? "" : "";

  const entries: SizeFormEntry[] = [];
  const byText = new Map<string, SizeFormEntry>();
  for (const s of split) {
    const text = hoist || !s.unit ? s.value : `${s.value} ${s.unit}`;
    const seen = byText.get(text);
    if (seen) {
      seen.labels.push(s.label);
      continue;
    }
    const entry: SizeFormEntry = { text, labels: [s.label] };
    byText.set(text, entry);
    entries.push(entry);
  }
  return { entries, joiner: "-", unit };
}

// The run as flat text — what backs readiness checks, show-values and file
// names. The renderer draws the same run itself so it can enlarge the
// current repetition's entry.
export function formatSizeFormRun(run: SizeFormRun): string {
  const body = run.entries.map((e) => e.text).join(run.joiner);
  if (!body) return "";
  return run.unit ? `${body} ${run.unit}` : body;
}

// The token argument as a form, or null for "no argument" / anything else
// (validateTokenRef is what rejects a bad one at publish time; a stray value
// must never blank a printed range).
export function parseSizeForm(arg: string | undefined): SizeForm | null {
  return arg && (SIZE_FORMS as readonly string[]).includes(arg) ? (arg as SizeForm) : null;
}

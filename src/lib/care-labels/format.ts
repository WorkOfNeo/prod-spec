// =====================================================
// Care-instruction text formatting — DB-free, shared by every render path.
//
// Care lines reach a label from two sources: the DB-managed care-label
// catalogue, translated per language via the Monday Translation board, and
// per-ProdSpec free-text overrides. Neither is guaranteed to be capitalized —
// board translations are typed by hand and often start lowercase. The house
// rule is that EVERY printed care instruction begins with a capital letter,
// so all render paths funnel their final per-language string through
// sanitizeCareInstructions before it reaches the label.
//
// Pure string logic, no DB — safe to import from client components (the admin
// preview panel) as well as the server renderers, unlike ./index.
// =====================================================

// The separator every care path uses to join individual instructions into one
// per-language line ("Machine wash 30° / Do not bleach / Iron low").
export const CARE_INSTRUCTION_SEPARATOR = " / ";

// Split on the canonical " / " separator (space-slash-space, matching the
// join) and on newlines a free-text override might contain. Deliberately does
// NOT match a bare "/" so real slashes inside a phrase ("inside/out") survive.
const CARE_SPLIT = / \/ |\r?\n/;

// Uppercase the first letter of a single care instruction, leaving the rest
// untouched. A phrase that starts with a non-letter (a digit, a quote) is
// returned as-is — there is nothing to capitalize. Trims surrounding
// whitespace so a split fragment sets cleanly.
export function capitalizeCarePhrase(phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Normalize a full care-instruction line so EVERY individual instruction it
// contains starts with a capital letter — not just the first. Splits on the
// separator, capitalizes each phrase, drops blanks, and rejoins with " / ".
// Idempotent: re-running on already-capitalized text is a no-op, so it is safe
// to apply at more than one point in a render path.
export function sanitizeCareInstructions(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .split(CARE_SPLIT)
    .map(capitalizeCarePhrase)
    .filter(Boolean)
    .join(CARE_INSTRUCTION_SEPARATOR);
}

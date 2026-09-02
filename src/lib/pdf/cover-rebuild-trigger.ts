// =====================================================
// WHY a cover is being rebuilt — the single input that decides whether the
// supplier is told about it.
//
// Every cover rebuild re-arms the style's supplier-send queue row, so the fresh
// file reaches the supplier's folder either way. The only open question is
// whether that row also rides tonight's digest as an EMAIL. That answer belongs
// to the trigger and nothing else — not to an operator checkbox, and not to
// whatever the row happened to say last time:
//
//   "content" — this style's own facts moved. An output was generated, approved
//     or rejected, so the manifest genuinely reads differently for THIS order
//     and the supplier has something to act on. They hear about it, exactly as
//     they always have.
//
//   "wording" — the house wording moved: the global cover block, a spec's
//     General information, or a trim concept's copy. The page reads differently
//     but nothing about the supplier's job changed. The file is re-uploaded;
//     the email is not sent. A wording edit sweeps the whole book, so "one email
//     per style" here is the 2026-08-13 mass send again, for a sentence.
//
// The rule is a function of the trigger alone, so it cannot latch: a style
// silenced by a wording sweep is re-armed to notifying by the next content
// rebuild, which is what stops one quiet regen from muting a cover for good
// (see requeue-cover.ts).
//
// PURE LEAF — no imports, so the sweep, the drain and their tests can all read
// the rule without dragging the render chain along.
// =====================================================

export type CoverRebuildTrigger = "content" | "wording";

// Does a rebuild with this trigger announce itself in the nightly digest?
export function notifiesSupplier(trigger: CoverRebuildTrigger): boolean {
  return trigger === "content";
}

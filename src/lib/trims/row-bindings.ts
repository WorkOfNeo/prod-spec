// =====================================================
// Which Monday trim values land on a packaging ROW — the same mapping
// /settings/trims edits from the value side, read and written from the row side.
//
// ONE STORE, TWO VIEWS. The mapping lives where it always did: the
// `trimLabelOverrides` AppSetting, a normalised-label -> row-ids record, written
// through PUT /api/admin/settings/trims. Nothing here persists anything of its
// own. A second store keyed by row would be the obvious shortcut and the
// obvious bug: the two would disagree the first time somebody edited one of
// them, and a cover would print whichever the render chain happened to read.
// So this module only inverts the record — value -> rows becomes rows -> values
// — and hands back an edited copy of the SAME record for the caller to save.
//
// THE THREE STATES A VALUE CAN BE IN, and why the key-presence check keeps
// coming back: a key that is ABSENT means "nobody has decided, follow the
// keyword rules"; a key holding a list means "a person decided these rows"; a
// key holding an EMPTY list means "a person decided this is not packaging at
// all, keep it off the cover". Those are three different things and the middle
// one is the only one an ordinary edit produces, so every function below tests
// for the key rather than for a truthy value.
//
// BINDING MATERIALISES THE SUGGESTION. Adding row R to a value that was still
// following the rules stores the rule's whole proposal plus R — not just R.
// Storing R alone would silently drop the other rows the value was already
// printing, which is exactly the kind of quiet loss the value-side editor
// avoids by showing the suggestion as removable chips.
//
// UNBINDING THE LAST ROW IS A REAL DECISION, not an undo. It leaves the empty
// list, i.e. "not packaging" — the value stops printing on covers entirely. The
// caller has to say so out loud in the UI; `unbindLabelFromRow` cannot soften
// it, because the alternative (deleting the key) would hand the value straight
// back to the keyword rule that put it on this row in the first place, and the
// removal would appear not to have worked.
//
// Pure: no db, no fetch, client-safe.
// =====================================================

export type TrimLabelOverrides = Record<string, string[]>;

// The subset of a census label this module needs. Kept structural so the
// census type (which drags a server module behind it) is not a dependency.
export type BindableLabel = {
  // The most common spelling — what a person recognises.
  label: string;
  // The normalised key the override record is keyed by.
  normalized: string;
  // How many in-scope styles carry it.
  styles: number;
  // What the keyword rules propose, regardless of what is stored.
  suggested: string[];
};

// Has a person decided this value, either way?
export function isLabelDecided(overrides: TrimLabelOverrides, normalized: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, normalized);
}

// The rows a value prints on RIGHT NOW: the stored decision when there is one,
// otherwise whatever the keyword rules propose.
export function effectiveRowsForLabel(
  overrides: TrimLabelOverrides,
  label: BindableLabel,
): string[] {
  return isLabelDecided(overrides, label.normalized)
    ? overrides[label.normalized]
    : label.suggested;
}

// Every value currently landing on one row, most-used first so the values that
// matter are the ones a person sees without scrolling.
export function labelsBoundToRow(
  overrides: TrimLabelOverrides,
  labels: ReadonlyArray<BindableLabel>,
  rowValue: string,
): BindableLabel[] {
  if (!rowValue) return [];
  return labels
    .filter((l) => effectiveRowsForLabel(overrides, l).includes(rowValue))
    .sort((a, b) => b.styles - a.styles || a.label.localeCompare(b.label));
}

// Add a row to a value, keeping every row it already named. Idempotent.
export function bindLabelToRow(
  overrides: TrimLabelOverrides,
  label: BindableLabel,
  rowValue: string,
): TrimLabelOverrides {
  const current = effectiveRowsForLabel(overrides, label);
  if (current.includes(rowValue)) {
    // Still worth storing: the value may have been FOLLOWING the rule onto this
    // row, and a person who ticked it here means it to stay there whatever a
    // later rule edit says.
    return { ...overrides, [label.normalized]: [...current] };
  }
  return { ...overrides, [label.normalized]: [...current, rowValue] };
}

// Remove a row from a value. Leaving no rows behind is the "not packaging"
// decision — see the header.
export function unbindLabelFromRow(
  overrides: TrimLabelOverrides,
  label: BindableLabel,
  rowValue: string,
): TrimLabelOverrides {
  const next = effectiveRowsForLabel(overrides, label).filter((r) => r !== rowValue);
  return { ...overrides, [label.normalized]: next };
}

// Would unbinding this row take the value off covers altogether? Asked BEFORE
// the click so the screen can say so, rather than after so it can apologise.
export function unbindingWouldSuppress(
  overrides: TrimLabelOverrides,
  label: BindableLabel,
  rowValue: string,
): boolean {
  return effectiveRowsForLabel(overrides, label).filter((r) => r !== rowValue).length === 0;
}

// The OTHER rows a value lands on. Shown beside every value on the row screen:
// a compound entry like "Hanger & Hangtag" legitimately names two rows, and
// somebody mapping it here needs to see that it is already printing somewhere
// else rather than discover it on a supplier's cover.
export function otherRowsForLabel(
  overrides: TrimLabelOverrides,
  label: BindableLabel,
  rowValue: string,
): string[] {
  return effectiveRowsForLabel(overrides, label).filter((r) => r !== rowValue);
}

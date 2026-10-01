// Filename for a multi-style carton marking: <PO>-<styleNumbers,>-Carton-Marking.pdf
//
// Deliberately NOT the layout's own settings.fileName template: that resolves
// against ONE style, and a group has several. The style numbers are listed
// main-first so the file sorts and reads the same way the marking prints.
//
// The name is persisted on CartonGroup at creation, because ungroup has to tell
// the reviewer which file to go and delete by hand — possibly long after the
// render itself is gone.

// Same sanitising as carton-render's fileName: keep word chars, dot, dash,
// space and comma (the separator), then collapse spaces to dashes.
function sanitize(s: string): string {
  return s.replace(/[^\w.\-, ]+/g, "").replace(/\s+/g, "-");
}

export function cartonGroupFileName(input: {
  poNumber: string | null | undefined;
  /** Main style's number — always printed first. */
  mainStyleNumber: string;
  /** The other styles on the box, in slot order. */
  otherStyleNumbers: ReadonlyArray<string>;
}): string {
  const seen = new Set<string>();
  const numbers: string[] = [];
  for (const raw of [input.mainStyleNumber, ...input.otherStyleNumbers]) {
    const n = (raw ?? "").trim();
    // A style with no number would render as an empty slot in the list and make
    // two different groups collide on one name — skip it rather than emit ",,".
    if (!n || seen.has(n)) continue;
    seen.add(n);
    numbers.push(n);
  }

  const po = (input.poNumber ?? "").trim();
  const stem = [po, numbers.join(",")].filter(Boolean).join("-");
  return `${sanitize(stem || "carton-group")}-Carton-Marking.pdf`;
}

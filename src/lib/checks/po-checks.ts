import { sanitizeFileName } from "@/lib/sharepoint/supplier-folder";
import { looksLikeCoverPage, coverNameBody, coverBodyMentionsStyle, carriesLayoutId } from "./file-name-shape";

// =====================================================
// The two self-service folder checks, as PURE functions: expected set + folder
// listing → rows a reviewer can act on. No Graph, no database, no clock — the
// composition lives in run-po-checks.ts. The decision logic is the part that
// must not be wrong, and it is the part CI can actually run.
//
// WHY A SEPARATE SURFACE FROM /delivery. The delivery ledger answers "did
// everything we owe the supplier arrive?" — it counts the EXPECTED side and
// treats the folder as evidence. These checks ask the mirror question: "is
// there anything in the folder that should not be there, or is there under the
// wrong name?" That starts from the FOUND side, and the two produce different
// rows from the same data. A ledger reports a stray file as one anonymous
// number; a reviewer needs to know which style it belongs to and whether it is
// safe to remove.
//
// THE ORDER OF THE TESTS IS THE DESIGN. Shape ("is this cover-page-shaped?",
// "does this carry a layout id?") is only ever a cheap filter for "worth asking
// about". What a file IS gets decided by diffing it against the expected set
// for the WHOLE PO — because the folder is PO-scoped and shared, and roughly
// three in five POs carry more than one style. Judging a file against one
// style's expectations would propose deleting its neighbour's artwork.
//
// TWO DELIBERATE RESTRAINTS, both visible in the row shape:
//
//   • `proposed` may be null. A flagged row whose finding we cannot EXPLAIN
//     gets no pre-selected action — it is listed, with the destructive action
//     merely permitted. The pre-selection is a recommendation, and the app has
//     no business recommending a deletion it can't justify in one sentence.
//   • `allowed` is empty for anything outside APPROVED LAYOUTS. That subfolder
//     is the only place this app has ever written; the PO folder above it holds
//     the order's own paperwork, which belongs to the customer and the
//     supplier. Those files are scanned and REPORTED — a cover sitting in the
//     wrong folder is worth seeing — and never offered a button.
// =====================================================

// SharePoint folder names are case-insensitive and the push writes
// sanitizeFileName(stored), so the only correct comparison key is the sanitised
// name lowercased — the same key po-delivery.ts and reconcile-folder.ts use. If
// the surfaces disagreed, one would call a file recognised and the other stray.
const key = (fileName: string) => sanitizeFileName(fileName).toLowerCase();

export type CheckAction = "rename" | "delete";

// Where in the PO folder a file was found. Only APPROVED_LAYOUTS is ours to
// act on; see the header.
export type FileLocation = "approved-layouts" | "po-folder";

export type FolderFile = {
  fileName: string;
  itemId: string;
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
  location: FileLocation;
};

// The cover this PO expects from one style, resolved against TODAY's naming
// rule. `previousName` is the name it was generated under when that differs —
// the same stamp-vs-template distinction ExpectedFile makes, and the reason a
// drifted cover reads as "rename me", not "delete me".
export type ExpectedCover = {
  styleId: string;
  styleName: string;
  // Every spelling of this style that could plausibly open a cover name, used
  // ONLY to attribute a cover we do not otherwise recognise. A list rather than
  // one slug because the style number a cover is named after is a render field,
  // not necessarily Style.name — so run-po-checks.ts contributes both, and the
  // failure mode of an extra entry is under-flagging (safe) rather than
  // proposing a deletion against the wrong style (not).
  styleSlugs: string[];
  currentName: string;
  previousName: string | null;
};

// The narrow slice of reconcile-folder's ExpectedFile these checks need. Kept
// structural so ExpectedFile satisfies it without a conversion step.
export type ExpectedDoc = {
  fileName: string; // what the layout's template asks for TODAY
  previousFileName: string | null; // the stamped name, when it differs
  styleId: string;
  styleName: string;
  name: string; // human display name of the output
  nameNote: string | null;
};

// WHAT KIND OF FINDING THIS IS — the machine-readable half of `verdict`.
//
// A verdict is a sentence written for the person looking at ONE folder, and it
// names the style in it. That is right for the per-PO page and useless across
// 300 orders: "every stale-named file in the book" has to group by the FAULT,
// and a fault cannot be recovered from prose. So each branch of the two checks
// below states its own kind, and the cross-order review reads that.
//
// Kinds are stable identifiers, not labels. Renaming one silently regroups an
// operator's saved view of the world, so they are only ever added to.
export type CheckRowKind =
  // Cover pages.
  | "cover-expected" // the cover this PO expects — coverage, not a finding
  | "cover-superseded" // an old copy; the current one is already in the folder
  | "cover-renamed" // the only copy, under a name the config has moved on from
  | "cover-unrecognised" // names a style on this PO, but not a name we generated
  | "cover-foreign" // our convention, for a style that is not on this PO
  | "cover-not-ours" // cover-shaped, not our convention at all
  // Output documents.
  | "file-expected" // the name the layout asks for today
  | "file-superseded" // a stale copy; the correctly-named file is already here
  | "file-renamed" // under the name it was generated with, not today's
  | "file-not-ours" // nothing on this PO claims the name; very often not ours
  | "layout-id-no-file-name" // delivering under its layout id, and still would
  | "layout-id-renameable" // leaked a layout id; the layout has a name now
  | "layout-id-orphan"; // carries a layout id nothing on this PO answers to

// How a cross-order review groups and orders the kinds. `severity` is the sort:
// 0 = a defect with a known repair, 1 = worth a person's eyes, 2 = coverage.
export const CHECK_ROW_KINDS: Record<
  CheckRowKind,
  { title: string; blurb: string; severity: 0 | 1 | 2 }
> = {
  "cover-superseded": {
    title: "Old cover, current one already there",
    blurb: "A cover from before the naming rule changed, sitting next to the correct one. Removing it is the whole repair.",
    severity: 0,
  },
  "cover-renamed": {
    title: "Cover under its generated name",
    blurb: "The only copy of the style's cover, under a name the config has moved on from. Rename in place — deleting it leaves the supplier with no cover.",
    severity: 0,
  },
  "layout-id-renameable": {
    title: "Leaked layout id, and the layout has a name now",
    blurb: "The file name fell back to the variant key. The layout has since been given a proper file name, so this is a straight rename.",
    severity: 0,
  },
  "file-superseded": {
    title: "Stale copy, correct name already there",
    blurb: "The correctly-named file is in the folder. Nothing reads this one any more.",
    severity: 0,
  },
  "file-renamed": {
    title: "Under the name it was generated with",
    blurb: "The artwork is approved and correct; only the name is behind the layout's current template.",
    severity: 0,
  },
  "cover-foreign": {
    title: "Cover for a style that is not on this PO",
    blurb: "It follows this app's cover naming convention, so it was generated here and landed in the wrong folder — or its style has moved off the order.",
    severity: 0,
  },
  "layout-id-no-file-name": {
    title: "Delivering under a layout id, with no name to move to",
    blurb: "The layout's file name is empty, so this is what the template resolves to TODAY. Fix the layout in the Output Builder first; there is nothing to rename to yet.",
    severity: 1,
  },
  "layout-id-orphan": {
    title: "Layout id nothing on this PO answers to",
    blurb: "Most likely left over from an output that has since been re-run or removed. No rename target, so a person decides.",
    severity: 1,
  },
  "cover-unrecognised": {
    title: "Cover under a name this app never generated",
    blurb: "It names a style that IS on the PO, but not under any name we have a record of — most likely a hand-made copy.",
    severity: 1,
  },
  "cover-not-ours": {
    title: "Cover-page-shaped, but not named by this app",
    blurb: "It does not follow the app's cover convention, so it may well be the supplier's or the customer's own file.",
    severity: 1,
  },
  "file-expected": {
    title: "Correctly named",
    blurb: "The name the layout asks for today.",
    severity: 2,
  },
  "cover-expected": {
    title: "Expected cover",
    blurb: "The cover this PO expects for the style.",
    severity: 2,
  },
  "file-not-ours": {
    title: "Not one of ours",
    blurb: "No document on the PO claims this name and it carries no tell — very often the supplier's or the customer's own upload.",
    severity: 2,
  },
};

export type CheckRow = {
  // The Graph item id. Actions address a file by id, never by name: a name is
  // ambiguous the moment somebody renames something between the scan and the
  // click.
  id: string;
  fileName: string;
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
  location: FileLocation;
  // What kind of finding this is, independent of the sentence below. See
  // CheckRowKind — the cross-order sweep groups on it.
  kind: CheckRowKind;
  // One sentence a reviewer can act on without opening anything else.
  verdict: string;
  detail: string | null;
  owner: { styleId: string; styleName: string } | null;
  // Pre-selected in the UI. null ⇒ listed for a human to judge, nothing ticked.
  proposed: CheckAction | null;
  allowed: CheckAction[];
  // Required whenever "rename" is allowed; null otherwise.
  renameTo: string | null;
};

export type CheckId = "cover-pages" | "output-file-names";

export type CheckSection = {
  id: CheckId;
  title: string;
  description: string;
  scanned: number;
  flagged: CheckRow[];
  ok: CheckRow[];
  // Findings that are not about a FILE — "two styles on this PO have no cover
  // in the folder at all". Shown, never actionable from here.
  notes: string[];
};

// Everything outside APPROVED LAYOUTS is report-only. Applied as a final step
// so no classifier has to remember it.
function withLocationGate(row: CheckRow): CheckRow {
  if (row.location === "approved-layouts") return row;
  return {
    ...row,
    proposed: null,
    allowed: [],
    renameTo: null,
    detail: [
      row.detail,
      "This file is in the PO folder itself, not in APPROVED LAYOUTS. The app has never written there — the order's own paperwork lives in that folder — so it is reported here and nothing is offered.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// Worst first, then by name, so a re-scan doesn't reshuffle the list under the
// reviewer's cursor.
function sortRows(rows: CheckRow[]): CheckRow[] {
  const rank = (r: CheckRow) => (r.proposed === "delete" ? 0 : r.proposed === "rename" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.fileName.localeCompare(b.fileName));
}

// -----------------------------------------------------
// Check 1 — cover pages in the PO folder
// -----------------------------------------------------
//
// The expected set is the WHOLE PO's covers, because the folder is the PO's. A
// cover named for a style number that is not on this PO is the finding this
// check exists for: it means a push went to the wrong folder, or a style moved
// off the order and left its cover behind.
export function buildCoverCheck(input: {
  expected: ExpectedCover[];
  present: FolderFile[];
}): CheckSection {
  const currentByKey = new Map<string, ExpectedCover>();
  const previousByKey = new Map<string, ExpectedCover>();
  for (const e of input.expected) {
    currentByKey.set(key(e.currentName), e);
    if (e.previousName) previousByKey.set(key(e.previousName), e);
  }
  const presentKeys = new Set(input.present.map((f) => key(f.fileName)));

  const covers = input.present.filter((f) => looksLikeCoverPage(f.fileName));
  const flagged: CheckRow[] = [];
  const ok: CheckRow[] = [];

  for (const f of covers) {
    const k = key(f.fileName);
    const base = {
      id: f.itemId,
      fileName: f.fileName,
      webUrl: f.webUrl,
      size: f.size,
      lastModifiedAt: f.lastModifiedAt,
      location: f.location,
    };

    const current = currentByKey.get(k);
    if (current) {
      ok.push({
        ...base,
        kind: "cover-expected",
        verdict: `The cover this PO expects for ${current.styleName}.`,
        detail: null,
        owner: { styleId: current.styleId, styleName: current.styleName },
        proposed: null,
        allowed: [],
        renameTo: null,
      });
      continue;
    }

    const previous = previousByKey.get(k);
    if (previous) {
      // The current name is already in the folder, so this one is a leftover
      // from before the cover naming rule changed. Removing it is the whole
      // repair; renaming would collide with the file that is already correct.
      if (presentKeys.has(key(previous.currentName))) {
        flagged.push(
          withLocationGate({
            ...base,
            kind: "cover-superseded",
            verdict: `An old copy of ${previous.styleName}'s cover — the current one is already in the folder.`,
            detail: `${previous.styleName} now delivers its cover as “${previous.currentName}”, which is present. Nothing reads this file any more.`,
            owner: { styleId: previous.styleId, styleName: previous.styleName },
            proposed: "delete",
            allowed: ["delete"],
            renameTo: null,
          }),
        );
        continue;
      }
      // The only copy of this style's cover, under a name the config has moved
      // on from. Rename it — deleting it would leave the supplier with no
      // cover, and regenerating would re-arm the supplier digest for what is
      // only ever a rename (see current-file-names.ts).
      flagged.push(
        withLocationGate({
          ...base,
          kind: "cover-renamed",
          verdict: `${previous.styleName}'s cover, under the name it was generated with.`,
          detail: `The cover naming rule has moved on. Rename in place to “${previous.currentName}” — the bytes are correct, only the name is behind.`,
          owner: { styleId: previous.styleId, styleName: previous.styleName },
          proposed: "rename",
          allowed: ["rename", "delete"],
          renameTo: previous.currentName,
        }),
      );
      continue;
    }

    // Not a name any style on this PO asks for, now or before. Attribute it if
    // we can: the convention spells the style number into the name.
    const body = coverNameBody(f.fileName);
    const owner = body
      ? input.expected.find((e) => e.styleSlugs.some((slug) => coverBodyMentionsStyle(body, slug)))
      : undefined;

    if (owner) {
      // It names a style that IS on this PO, but under a name nothing in the
      // app generated — a hand-made copy, or a cover from a naming rule older
      // than anything we can still resolve. We cannot say which, so we do not
      // pre-select its removal.
      flagged.push(
        withLocationGate({
          ...base,
          kind: "cover-unrecognised",
          verdict: `A cover for ${owner.styleName}, under a name this app never generated.`,
          detail: `${owner.styleName}'s cover is delivered as “${owner.currentName}”. This file is not that, and not a name we have a record of — most likely a hand-made copy. Check it before removing it.`,
          owner: { styleId: owner.styleId, styleName: owner.styleName },
          proposed: null,
          allowed: ["delete"],
          renameTo: null,
        }),
      );
      continue;
    }

    if (body) {
      // It follows the app's own convention, so it WAS generated here — for a
      // style that is not on this purchase order. That is a cover in the wrong
      // folder, and it is the finding this check was built for.
      flagged.push(
        withLocationGate({
          ...base,
          kind: "cover-foreign",
          verdict: `A cover for “${body}” — no style on this PO has that number.`,
          detail:
            "It follows this app's cover naming convention, so it was generated here and landed in the wrong folder, or its style has since moved off this PO.",
          owner: null,
          proposed: "delete",
          allowed: ["delete"],
          renameTo: null,
        }),
      );
      continue;
    }

    // Cover-page-shaped but not our convention at all — very often somebody
    // else's upload. Listed so it is visible; never pre-selected.
    flagged.push(
      withLocationGate({
        ...base,
        kind: "cover-not-ours",
        verdict: "Cover-page-shaped, but not named by this app.",
        detail:
          "It does not follow the “00-<style>-cover-page.pdf” convention, so it was not generated here. It may well be the supplier's or the customer's own file — check before removing it.",
        owner: null,
        proposed: null,
        allowed: ["delete"],
        renameTo: null,
      }),
    );
  }

  // The mirror finding: a style on the PO whose cover is not in the folder
  // under EITHER name. Not a file, so not a row — but a reviewer looking at
  // cover coverage needs to know the folder is short as well as crowded.
  const notes: string[] = [];
  const absent = input.expected.filter(
    (e) => !presentKeys.has(key(e.currentName)) && !(e.previousName && presentKeys.has(key(e.previousName))),
  );
  if (absent.length > 0) {
    notes.push(
      `${absent.length} style${absent.length === 1 ? "" : "s"} on this PO ${absent.length === 1 ? "has" : "have"} no cover in the folder at all (${absent
        .map((e) => e.styleName)
        .join(", ")}). That is a delivery shortfall, not a stray file — repair it from the PO's delivery page.`,
    );
  }

  return {
    id: "cover-pages",
    title: "Cover pages in the PO folder",
    description:
      "Every style on this purchase order shares one folder, so the covers that belong in it are the covers of all of them. This lists everything cover-page-shaped that is actually there and says which style each one answers to.",
    scanned: covers.length,
    flagged: sortRows(flagged),
    ok: sortRows(ok),
    notes,
  };
}

// -----------------------------------------------------
// Check 2 — misnamed output files
// -----------------------------------------------------
//
// THE STAMP IS NOT THE ANSWER. JobAsset.fileName is frozen at generation, so a
// file whose name drifted is only visible by comparing it against the name that
// resolves TODAY. That resolution has already happened by the time this
// function runs (ExpectedDoc.fileName is the template's current answer,
// previousFileName the stamp) — see current-file-names.ts for why it must be
// resolved that way and never guessed from the stored name.
//
// The layout-id test runs BEFORE the "it matches what we expect" test, and that
// ordering is load-bearing. A layout whose settings.fileName is still empty
// resolves TODAY to the same leaked "layout-<id>" name it was generated with,
// so the file matches the expected set exactly and would read as fine. It is
// not fine — it is the defect, sitting in its steady state.
export function buildFileNameCheck(input: {
  expected: ExpectedDoc[];
  present: FolderFile[];
}): CheckSection {
  const currentByKey = new Map<string, ExpectedDoc>();
  const previousByKey = new Map<string, ExpectedDoc>();
  for (const e of input.expected) {
    currentByKey.set(key(e.fileName), e);
    if (e.previousFileName) previousByKey.set(key(e.previousFileName), e);
  }
  const presentKeys = new Set(input.present.map((f) => key(f.fileName)));

  // Covers are check 1's subject. Judging them here as well would show the same
  // file twice and offer two different remedies for it.
  const files = input.present.filter((f) => !looksLikeCoverPage(f.fileName));
  const flagged: CheckRow[] = [];
  const ok: CheckRow[] = [];

  for (const f of files) {
    const k = key(f.fileName);
    const base = {
      id: f.itemId,
      fileName: f.fileName,
      webUrl: f.webUrl,
      size: f.size,
      lastModifiedAt: f.lastModifiedAt,
      location: f.location,
    };
    const current = currentByKey.get(k);
    const previous = previousByKey.get(k);

    if (carriesLayoutId(f.fileName)) {
      if (current) {
        // Still the config's own answer: the template is empty TODAY, so
        // regenerating or re-pushing would write this same name again. There is
        // no correct name to rename to, and that is the point of the row.
        flagged.push(
          withLocationGate({
            ...base,
            kind: "layout-id-no-file-name",
            verdict: `“${current.name}” is delivering under its layout id — the layout has no file name.`,
            detail:
              "The layout's file name is empty, so the runner fell back to the variant key. This is what the template resolves to TODAY, so there is no correct name to rename to yet: set a file name on the layout in the Output Builder, then use “Fix output filenames” to rename this file in place.",
            owner: { styleId: current.styleId, styleName: current.styleName },
            proposed: null,
            allowed: [],
            renameTo: null,
          }),
        );
        continue;
      }
      if (previous) {
        // The template has since been given a name — this file is the old,
        // leaked one and the rename is a straight repair.
        flagged.push(
          withLocationGate({
            ...base,
            kind: "layout-id-renameable",
            verdict: `“${previous.name}” leaked its layout id into the file name.`,
            detail: `The layout has a proper file name now. Rename in place to “${previous.fileName}”.`,
            owner: { styleId: previous.styleId, styleName: previous.styleName },
            proposed: "rename",
            allowed: ["rename", "delete"],
            renameTo: previous.fileName,
          }),
        );
        continue;
      }
      flagged.push(
        withLocationGate({
          ...base,
          kind: "layout-id-orphan",
          verdict: "Carries a layout id, and no document on this PO answers to it.",
          detail:
            "Nothing currently expected on this PO wants this name under either its current or its generated spelling, so there is nothing to rename it to. It is most likely left over from an output that has since been re-run or removed.",
          owner: null,
          proposed: null,
          allowed: ["delete"],
          renameTo: null,
        }),
      );
      continue;
    }

    if (current) {
      ok.push({
        ...base,
        kind: "file-expected",
        verdict: `“${current.name}” for ${current.styleName} — the name the layout asks for today.`,
        detail: null,
        owner: { styleId: current.styleId, styleName: current.styleName },
        proposed: null,
        allowed: [],
        renameTo: null,
      });
      continue;
    }

    if (previous) {
      if (presentKeys.has(key(previous.fileName))) {
        // The correctly-named file is already up. Renaming would collide; this
        // copy is simply stale. Mirrors fix-output-filenames' delete-stale arm.
        flagged.push(
          withLocationGate({
            ...base,
            kind: "file-superseded",
            verdict: `A stale copy of “${previous.name}” — the correctly-named file is already here.`,
            detail: `${previous.styleName} delivers this document as “${previous.fileName}”, which is present. Nothing reads this file any more.`,
            owner: { styleId: previous.styleId, styleName: previous.styleName },
            proposed: "delete",
            allowed: ["delete"],
            renameTo: null,
          }),
        );
        continue;
      }
      flagged.push(
        withLocationGate({
          ...base,
          kind: "file-renamed",
          verdict: `“${previous.name}” is under the name it was generated with, not the one its layout asks for now.`,
          detail:
            `Rename in place to “${previous.fileName}” — the artwork is approved and correct, only the name is behind.` +
            (previous.nameNote ? ` (${previous.nameNote})` : ""),
          owner: { styleId: previous.styleId, styleName: previous.styleName },
          proposed: "rename",
          allowed: ["rename", "delete"],
          renameTo: previous.fileName,
        }),
      );
      continue;
    }

    // Nothing on this PO claims it and it carries no tell. Very often the
    // supplier's or the customer's own upload, so it is shown as scanned-and-
    // left-alone rather than flagged — this check is about names WE got wrong.
    ok.push({
      ...base,
      kind: "file-not-ours",
      verdict: "Not one of ours — no document on this PO claims this name.",
      detail: null,
      owner: null,
      proposed: null,
      allowed: [],
      renameTo: null,
    });
  }

  return {
    id: "output-file-names",
    title: "Output files under the wrong name",
    description:
      "An output is named once, at generation, and the name is frozen. Every file here is checked against the name its layout resolves to TODAY — so a template that was edited after approval shows up as a rename, not as a missing file.",
    scanned: files.length,
    flagged: sortRows(flagged),
    ok: sortRows(ok),
    notes: [],
  };
}

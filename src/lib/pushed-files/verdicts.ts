import { sanitizeFileName } from "@/lib/sharepoint/supplier-folder";
import type { CheckAction } from "@/lib/checks/po-checks";

// =====================================================
// "Which of the files WE pushed are wrong?" — as a PURE function.
//
// WHY THIS IS NOT ANOTHER FOLDER CHECK. /checks and /checks/sweep reason
// folder-first: list everything present, build what the purchase order expects,
// and diff. That is the right question when you are asking "is this folder
// correct", and it is the only way to notice a file nobody has a record of.
// It also means the answer can, in principle, name a file this app never
// created — a supplier's own document, the buyer's paperwork — and offer a
// button next to it. The folder-first checks spend a lot of care making sure
// that never turns into a bad deletion (attribution, the location gate, the
// "we can't explain it, so nothing is pre-selected" rule).
//
// This module starts from the other end. The input is our OWN push records —
// one row per file this app uploaded, with the name it uploaded under. Every
// row of output is derived from a record. A file in the folder that no record
// claims is not examined, not counted and not returned: it cannot be flagged
// because there is no code path that could produce a row for it. That is a
// structural guarantee rather than a rule someone has to remember, and it is
// the entire reason this surface exists.
//
// The second reason is cost. Nothing here builds an expectation. The folder-
// first check has to walk every style's current outputs to know what SHOULD be
// in the folder — six or so round trips per style, the expensive half of a
// sweep. Record-first already knows which file it uploaded; the only question
// left is what that one document should be CALLED today, which is one render
// context per style and no Graph traffic at all.
//
// WHAT IT DOES NOT DECIDE. Presence is the caller's evidence: a folder that
// could not be listed must never reach this function, because "no files found"
// and "we could not look" are the same input here and opposite conclusions.
// check-folder.ts holds that line.
// =====================================================

// SharePoint names are case-insensitive and the push writes
// sanitizeFileName(stored), so the only correct comparison key is the sanitised
// name lowercased — the same key po-checks.ts, po-delivery.ts and
// reconcile-folder.ts use. Surfaces that key files differently eventually
// disagree about whether a file is present at all.
const key = (fileName: string) => sanitizeFileName(fileName).toLowerCase();

// One file this app uploaded into one APPROVED LAYOUTS folder.
//
// `pushedName` is read off the recorded file URL rather than taken from
// JobAsset.fileName. The stamp is what generation FROZE; the URL is what the
// upload actually created, and after a restamp those two disagree. The folder
// holds the second one, so that is the one we look for.
export type PushedRecord = {
  queueItemId: string;
  styleId: string;
  styleName: string;
  docType: string;
  displayName: string | null;
  poNumber: string;
  poSeq: number | null;
  pushedName: string;
  // What this document's layout resolves to TODAY. null when the current name
  // could not be worked out — an unpublished layout, a split row that no longer
  // exists, a framing page that never had a template. Never a guess: renaming a
  // file onto a guess is how the wrong artwork ends up under the right name.
  currentName: string | null;
  // Why there is no current name, for the row's detail line.
  currentNote: string | null;
};

// A file actually in the folder, as listChildFiles returns it.
export type PushedFolderFile = {
  fileName: string;
  itemId: string;
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
};

// WHAT KIND OF FAULT THIS IS. Stable identifiers, added to and never renamed —
// the cross-folder rollup groups on them, so a rename silently regroups
// somebody's picture of the book.
//
// The three flagged kinds are faults with a repair. The rest are reported so a
// person can see the whole of what we pushed, and carry no action at all.
export type PushedFileKind =
  // Faults.
  | "below-cutoff" // pushed for a PO under the supplier-send cutoff — it should never have gone
  | "name-drifted" // still there, under a name the layout has moved on from
  | "superseded-duplicate" // an older copy sitting next to its replacement
  // Reported, never flagged.
  | "gone" // we pushed it; it is not in the folder any more
  | "collision" // two of our records point at ONE file — nothing is safe to do
  | "unverifiable" // present, but today's name cannot be resolved, so we cannot judge it
  | "matches"; // present, under the name the layout asks for today

export const PUSHED_FILE_KINDS: Record<
  PushedFileKind,
  { title: string; blurb: string; severity: 0 | 1 | 2; flagged: boolean }
> = {
  "below-cutoff": {
    title: "Pushed below the supplier-send cutoff",
    blurb:
      "This file was uploaded for a purchase order under the cutoff, so it should never have been delivered at all. Whether it now comes back out of a supplier's folder is a commercial call, not a mechanical one — so nothing is pre-selected.",
    severity: 0,
    flagged: true,
  },
  "superseded-duplicate": {
    title: "Older copy, replacement already there",
    blurb:
      "We pushed this file, then pushed its replacement under a different name. Both are in the folder and nothing reads this one any more. Removing it is the whole repair.",
    severity: 0,
    flagged: true,
  },
  "name-drifted": {
    title: "Under the name we pushed it with",
    blurb:
      "The only copy, under a name the layout's file-name template has since moved on from. The bytes are right; rename it in place. Deleting it would leave the supplier without the document.",
    severity: 0,
    flagged: true,
  },
  collision: {
    title: "Two of our records, one file",
    blurb:
      "More than one thing we pushed resolves to the same file in the folder, so one overwrote the other. Nothing here is safe to touch automatically — the fix is in the layout's file name, not in the folder.",
    severity: 1,
    flagged: false,
  },
  unverifiable: {
    title: "Present, but we cannot name it today",
    blurb:
      "The file we pushed is still there, but its layout no longer resolves to a file name — unpublished, or a split row that no longer exists — so there is nothing to compare it against. Listed, never acted on.",
    severity: 1,
    flagged: false,
  },
  gone: {
    title: "We pushed it; it is not there now",
    blurb:
      "The folder no longer holds the file this record uploaded, under that name or under today's. Useful signal — somebody tidied up, or it was moved — but not a fault this page can repair.",
    severity: 2,
    flagged: false,
  },
  matches: {
    title: "Correct",
    blurb: "Present, under the name its layout asks for today.",
    severity: 2,
    flagged: false,
  },
};

export type PushedFileRow = {
  // The Graph item id when there is a file to address, null for a "gone" row.
  // Actions address a file by id, never by name — a name is ambiguous the
  // moment somebody renames something between the scan and the click.
  itemId: string | null;
  // Stable row identity for the UI and for an action request. The item id when
  // we have one; otherwise the record, which is the only thing a gone row is.
  id: string;
  queueItemId: string;
  fileName: string;
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
  kind: PushedFileKind;
  // One sentence someone can act on without opening anything else.
  verdict: string;
  detail: string | null;
  owner: { styleId: string; styleName: string };
  docType: string;
  poNumber: string;
  poSeq: number | null;
  // The name we uploaded under, kept on the row so the history reads honestly.
  pushedName: string;
  // Pre-selected in the UI. null ⇒ listed for a person to judge, nothing ticked.
  proposed: CheckAction | null;
  allowed: CheckAction[];
  // Required whenever "rename" is allowed; null otherwise.
  renameTo: string | null;
};

export type PushedFileSection = {
  // How many of OUR records were examined. Not "how many files are in the
  // folder" — that number is deliberately never computed, because this page has
  // no business counting somebody else's documents.
  records: number;
  flagged: PushedFileRow[];
  reported: PushedFileRow[];
  notes: string[];
};

// Counted by fault, for the cross-folder rollup. Stored per folder so the
// rollup a running scan re-reads every few seconds costs a few hundred bytes
// per folder rather than every row in the book.
export type PushedKindHistogram = Partial<
  Record<PushedFileKind, { files: number; renameable: number; deletable: number }>
>;

export function summarisePushedRows(rows: readonly PushedFileRow[]): PushedKindHistogram {
  const out: PushedKindHistogram = {};
  for (const r of rows) {
    const e = (out[r.kind] ??= { files: 0, renameable: 0, deletable: 0 });
    e.files += 1;
    if (r.allowed.includes("rename")) e.renameable += 1;
    if (r.allowed.includes("delete")) e.deletable += 1;
  }
  return out;
}

export type PushedFileGroup = {
  kind: PushedFileKind;
  title: string;
  blurb: string;
  severity: 0 | 1 | 2;
  flagged: boolean;
  files: number;
  folders: number;
  renameable: number;
  deletable: number;
};

// Pure. Every folder's histogram → the book's faults, worst first.
export function groupPushedHistograms(rows: readonly PushedKindHistogram[]): PushedFileGroup[] {
  const byKind = new Map<PushedFileKind, { files: number; folders: number; renameable: number; deletable: number }>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!v || v.files === 0) continue;
      const kind = k as PushedFileKind;
      const g = byKind.get(kind) ?? { files: 0, folders: 0, renameable: 0, deletable: 0 };
      g.files += v.files;
      g.folders += 1;
      g.renameable += v.renameable;
      g.deletable += v.deletable;
      byKind.set(kind, g);
    }
  }
  return [...byKind.entries()]
    .map(([kind, g]) => ({
      kind,
      title: PUSHED_FILE_KINDS[kind]?.title ?? kind,
      blurb: PUSHED_FILE_KINDS[kind]?.blurb ?? "",
      severity: PUSHED_FILE_KINDS[kind]?.severity ?? 1,
      flagged: PUSHED_FILE_KINDS[kind]?.flagged ?? false,
      ...g,
    }))
    .sort((a, b) => a.severity - b.severity || b.files - a.files || a.kind.localeCompare(b.kind));
}

// Worst first, then by name, so a re-scan does not reshuffle the list under a
// reviewer's cursor.
function sortRows(rows: PushedFileRow[]): PushedFileRow[] {
  return [...rows].sort(
    (a, b) =>
      PUSHED_FILE_KINDS[a.kind].severity - PUSHED_FILE_KINDS[b.kind].severity ||
      a.fileName.localeCompare(b.fileName),
  );
}

// The whole check for ONE folder.
//
// `present` must be a listing that actually SUCCEEDED. An empty array here is
// read as "we pushed twelve files and none of them are there", which is a
// perfectly good answer for a folder somebody emptied and a catastrophic one
// for a 403. The caller owns that distinction — see check-folder.ts.
//
// `minPo` is the supplier-send cutoff. null (unset) means no PO is below it.
export function buildPushedFileCheck(input: {
  records: readonly PushedRecord[];
  present: readonly PushedFolderFile[];
  minPo: number | null;
}): PushedFileSection {
  const { records, present, minPo } = input;

  // The folder, keyed the one correct way. When two files in one folder share a
  // sanitised key — SharePoint would not normally allow it, but a listing is
  // not a contract — the first wins and the second is simply never addressed.
  const presentByKey = new Map<string, PushedFolderFile>();
  for (const f of present) {
    const k = key(f.fileName);
    if (!presentByKey.has(k)) presentByKey.set(k, f);
  }

  // WHICH FILE EACH RECORD IS, resolved before anything is judged.
  //
  // A record is represented by the file under the name we pushed it with, or —
  // when that is absent and today's name is present — by the file under today's
  // name. The second arm matters: /settings/approved's "Fix output filenames"
  // and the per-PO checks both rename our files in place, and a record whose
  // file has already been corrected is healthy, not missing.
  const represented = new Map<string, PushedFolderFile | null>();
  for (const r of records) {
    const pushed = presentByKey.get(key(r.pushedName)) ?? null;
    const current = r.currentName ? (presentByKey.get(key(r.currentName)) ?? null) : null;
    represented.set(r.queueItemId, pushed ?? current);
  }

  // TWO RECORDS, ONE FILE. Two things we pushed that now resolve to the same
  // item mean one upload overwrote the other — the split-layout file-name
  // collision. Neither record's file may be touched: a delete removes the
  // survivor of the pair, and a rename moves it out from under the other
  // record. The repair is in the layout's file name, and it is not ours to make
  // from a folder listing.
  const claimants = new Map<string, number>();
  for (const f of represented.values()) {
    if (f) claimants.set(f.itemId, (claimants.get(f.itemId) ?? 0) + 1);
  }

  const rows: PushedFileRow[] = [];

  for (const r of records) {
    const file = represented.get(r.queueItemId) ?? null;
    const label = r.displayName?.trim() || r.docType;
    const base = {
      queueItemId: r.queueItemId,
      owner: { styleId: r.styleId, styleName: r.styleName },
      docType: r.docType,
      poNumber: r.poNumber,
      poSeq: r.poSeq,
      pushedName: r.pushedName,
    };

    if (!file) {
      rows.push({
        ...base,
        id: `record:${r.queueItemId}`,
        itemId: null,
        fileName: r.pushedName,
        webUrl: null,
        size: null,
        lastModifiedAt: null,
        kind: "gone",
        verdict: `We uploaded ${label} for ${r.styleName}; it is not in the folder now.`,
        detail:
          r.currentName && key(r.currentName) !== key(r.pushedName)
            ? `Not under the name we pushed it with, and not under the name its layout asks for today either. Nothing to repair from here — re-deliver it from the PO's delivery page if it is still owed.`
            : `Nothing to repair from here — re-deliver it from the PO's delivery page if it is still owed.`,
        proposed: null,
        allowed: [],
        renameTo: null,
      });
      continue;
    }

    const rowBase = {
      ...base,
      id: file.itemId,
      itemId: file.itemId,
      fileName: file.fileName,
      webUrl: file.webUrl,
      size: file.size,
      lastModifiedAt: file.lastModifiedAt,
    };

    if ((claimants.get(file.itemId) ?? 0) > 1) {
      rows.push({
        ...rowBase,
        kind: "collision",
        verdict: `More than one document we pushed for this order ends up as this one file.`,
        detail:
          "Two uploads resolved to the same file name, so the later one overwrote the earlier. Nothing is offered here: removing it takes the survivor, renaming it moves it out from under the other record. Give the layout a file name that varies, then re-run the outputs.",
        proposed: null,
        allowed: [],
        renameTo: null,
      });
      continue;
    }

    // THE CUTOFF COMES FIRST, before any question about the name. A file that
    // should never have been delivered is not made right by being renamed, and
    // "rename this into its correct current name" would be the wrong repair to
    // put in front of somebody looking at an order that is out of scope.
    if (minPo != null && r.poSeq != null && r.poSeq < minPo) {
      rows.push({
        ...rowBase,
        kind: "below-cutoff",
        verdict: `${label} for ${r.styleName}, delivered for an order below the supplier-send cutoff.`,
        detail: `The cutoff is ${minPo}; this order is ${r.poSeq}. Nothing on it should have been sent to a supplier, so this file is here by mistake. It is not pre-selected: the supplier may already be working from it, and that is a decision for a person.`,
        proposed: null,
        allowed: ["delete"],
        renameTo: null,
      });
      continue;
    }

    if (!r.currentName) {
      rows.push({
        ...rowBase,
        kind: "unverifiable",
        verdict: `${label} for ${r.styleName} is in the folder, but we cannot say what it should be called today.`,
        detail: r.currentNote ?? "Its layout does not resolve to a file name right now, so there is nothing to compare against.",
        proposed: null,
        allowed: [],
        renameTo: null,
      });
      continue;
    }

    if (key(file.fileName) === key(r.currentName)) {
      rows.push({
        ...rowBase,
        kind: "matches",
        verdict: `${label} for ${r.styleName}, under the name its layout asks for today.`,
        detail: null,
        proposed: null,
        allowed: [],
        renameTo: null,
      });
      continue;
    }

    // The name has drifted. Which repair depends on whether the replacement is
    // already in the folder — renaming onto a name that is taken would collide,
    // and deleting the only copy would leave the supplier short.
    const replacement = presentByKey.get(key(r.currentName));
    if (replacement && replacement.itemId !== file.itemId) {
      rows.push({
        ...rowBase,
        kind: "superseded-duplicate",
        verdict: `An older copy of ${label} for ${r.styleName} — the current one is already in the folder.`,
        detail: `This document now delivers as “${sanitizeFileName(r.currentName)}”, which is present. Nothing reads this file any more.`,
        proposed: "delete",
        allowed: ["delete"],
        renameTo: null,
      });
      continue;
    }

    rows.push({
      ...rowBase,
      kind: "name-drifted",
      verdict: `${label} for ${r.styleName}, under the name we pushed it with.`,
      detail: `Its layout's file name now resolves to “${sanitizeFileName(r.currentName)}”. The bytes are correct; only the name is behind. Renaming in place is the whole repair — the file is not regenerated and no supplier is emailed.`,
      proposed: "rename",
      // Rename only. This file is the supplier's only copy of a document they
      // are owed; "delete" is never the repair for a name being out of date.
      allowed: ["rename"],
      renameTo: sanitizeFileName(r.currentName),
    });
  }

  const flagged = rows.filter((r) => PUSHED_FILE_KINDS[r.kind].flagged);
  const reported = rows.filter((r) => !PUSHED_FILE_KINDS[r.kind].flagged);

  const notes: string[] = [];
  const gone = reported.filter((r) => r.kind === "gone").length;
  if (gone > 0) {
    notes.push(
      `${gone} file${gone === 1 ? "" : "s"} we pushed into this folder ${gone === 1 ? "is" : "are"} no longer there. That is reported, not flagged — this page repairs files it can still see.`,
    );
  }

  return { records: records.length, flagged: sortRows(flagged), reported: sortRows(reported), notes };
}

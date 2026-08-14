import { sanitizeFileName } from "./supplier-folder";
import type { ExpectedFile, ReconcileState } from "./reconcile-folder";

// =====================================================
// "Did every approved document for this PURCHASE ORDER actually reach the
// supplier's folder?" — the delivery ledger, counted per file name.
//
// WHY THIS IS NOT THE STYLE PANEL. reconcile-folder.ts answers the same
// question for the style you happen to be looking at. That is the wrong unit
// twice over:
//
//   • The folder is the PO's. A style with ZERO documents delivered is
//     invisible unless somebody opens that exact style — and on the live PO
//     that prompted this, one of the three styles had nothing uploaded at all
//     while the other two looked fine.
//   • Nobody audits by opening styles one at a time. "Are all files delivered?"
//     is a question about the whole book, and it can only be answered by a
//     surface whose unit is the folder.
//
// WHY COUNTING, NOT SET MEMBERSHIP. This is the subtle one, and it is the whole
// reason this module exists rather than a widened diff.
//
// SharePoint can hold exactly ONE file per name in a folder. So when two
// approved documents resolve to the SAME file name — two styles sharing a style
// number, or a split output whose template omits the size — the second upload
// OVERWRITES the first. Both documents then "match" the one file that is there,
// and a set-based diff reports both as delivered. The artwork is gone and every
// check says fine.
//
// Counting is what catches it: N documents want this name, the folder can hold
// one, so N-1 of them are undeliverable BY CONSTRUCTION and no amount of
// re-pushing will fix it. That is a naming defect, not a transfer failure, and
// it needs a human to make the template specific enough — which is why each
// collision reports exactly what differs between the documents that share a
// name (`distinguishers`). Auto-suffixing was considered and rejected: a
// filename is what the supplier prints against, and the app inventing "(2)" is
// worse than saying plainly that the template is ambiguous.
//
// The two failure modes are therefore reported SEPARATELY, because their
// repairs have nothing in common:
//   • missing / renamed → a transfer problem. Self-healing: re-push the
//     approved bytes (they are in JobAsset.pdf) under the current name.
//   • colliding        → a naming problem. NOT self-healing, on purpose.
//
// Everything above the "Composition" banner is pure and unit tested: there is
// no Graph and no database in CI, and the counting logic is the part that must
// not be wrong.
// =====================================================

// What happened to one approved document, from the folder's point of view.
export type DeliveryStatus =
  // Its name is in the folder and no other document claims that name.
  | "delivered"
  // Its name is in the folder but other documents claim it too. ONE of them is
  // the file that is actually there; the rest were overwritten. We cannot tell
  // which survived — the name is all we have — so every claimant carries this.
  | "colliding"
  // Its CURRENT name is absent but the name it was generated under is present:
  // the layout's template was edited after approval. The bytes are there, the
  // name is behind.
  | "renamed"
  // Neither name is in the folder. It never landed, or something removed it.
  | "missing";

export type DeliveryDocument = {
  styleId: string;
  styleName: string;
  variantKey: string;
  name: string; // human display name of the output
  docType: string;
  jobAssetId: string;
  fileName: string; // the name its layout asks for today (sanitised)
  previousFileName: string | null;
  status: DeliveryStatus;
  queueItemId: string | null;
  queueStatus: string | null;
};

// Every document that wants one particular file name. `wanted > 1` is the
// collision: the folder cannot hold them all.
export type DeliveryNameGroup = {
  fileName: string;
  wanted: number;
  present: boolean;
  // Present only under the old name (all claimants are `renamed`).
  presentAsPrevious: boolean;
  documents: DeliveryDocument[];
  // Plain-English list of what actually differs between colliding documents —
  // the token the file-name template is missing. Empty unless wanted > 1.
  distinguishers: string[];
};

// A file sitting in the folder that no document on this PO asks for, under
// either name. Kept distinct from `staleFiles` because the repairs differ: a
// stale file is ours to remove once nothing needs it, a stray is very often the
// supplier's or the customer's own upload and must be left alone.
export type DeliveryFile = {
  fileName: string;
  itemId: string;
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
};

export type DeliveryStyleRollup = {
  styleId: string;
  styleName: string;
  expected: number;
  delivered: number;
};

export type PoDeliveryTotals = {
  expectedDocs: number;
  deliveredDocs: number;
  renamedDocs: number;
  missingDocs: number;
  // Documents that cannot land while they share a name with another document.
  // Counted as sum(wanted - 1) over colliding names: one of each group CAN be
  // in the folder, the rest never can.
  collisionDocs: number;
  collisionNames: number;
  strayFiles: number;
  staleFiles: number;
};

export type PoDeliveryReport = {
  poNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  state: ReconcileState;
  message: string;
  folderUrl: string | null;
  folderPath: string | null;
  poFolderUrl: string | null;
  styles: DeliveryStyleRollup[];
  totals: PoDeliveryTotals;
  names: DeliveryNameGroup[];
  strayFiles: DeliveryFile[];
  staleFiles: DeliveryFile[];
  checkedAt: string;
};

// SharePoint folder names are case-insensitive and the push writes
// sanitizeFileName(stored), so the only correct comparison key is the sanitised
// name lowercased — the same key reconcile-folder.ts compares on. If the two
// ever disagreed, one surface would call a file delivered and the other
// missing.
const key = (fileName: string) => sanitizeFileName(fileName).toLowerCase();

// What differs between documents that resolved to the same file name. This is
// the actionable half of a collision report: "these two are different COLOURS"
// tells you the template needs {{colourName}}, which is a thirty-second fix in
// the Output Builder, where "duplicate file name" tells you nothing.
//
// Ordered most-useful first and capped: a group of eight documents differing by
// size does not need eight labels to make the point.
export function describeDistinguishers(docs: DeliveryDocument[]): string[] {
  if (docs.length < 2) return [];
  const out: string[] = [];

  const styles = [...new Set(docs.map((d) => d.styleName))];
  const styleIds = [...new Set(docs.map((d) => d.styleId))];
  if (styleIds.length > 1) {
    // The nastiest shape: two Monday rows for the same style number, so even a
    // style-number-prefixed name collides. Worth saying explicitly.
    out.push(
      styles.length === 1
        ? `${styleIds.length} different styles that share the style number “${styles[0]}”`
        : `different styles (${styles.join(", ")})`,
    );
  }

  // The split suffix IS the size/colour discriminator the runner already uses.
  const suffixes = [...new Set(docs.map((d) => d.variantKey.split("#")[1] ?? "—"))];
  if (suffixes.length > 1) {
    out.push(`different sizes/colours (${suffixes.slice(0, 4).join(", ")}${suffixes.length > 4 ? ", …" : ""})`);
  }

  const bases = [...new Set(docs.map((d) => d.variantKey.split("#")[0]))];
  if (bases.length > 1) out.push(`different outputs (${[...new Set(docs.map((d) => d.name))].join(", ")})`);

  // Nothing distinguishes them at all — the same output, the same split row,
  // twice. That is a duplicate document, not an ambiguous template.
  if (out.length === 0) out.push("nothing distinguishes them — these look like duplicate documents");
  return out;
}

// The whole decision logic, pure: expected documents (PO-wide) + the folder
// listing → the delivery ledger. No Graph, no DB, no clock.
//
// `present` is a LIST but behaves as a set — SharePoint cannot hold two files
// whose names differ only by case in one folder. The expected side is a
// MULTISET, and that asymmetry is the entire point of the module.
export function buildDeliveryLedger(input: {
  expected: ExpectedFile[];
  present: DeliveryFile[];
}): {
  names: DeliveryNameGroup[];
  documents: DeliveryDocument[];
  strayFiles: DeliveryFile[];
  staleFiles: DeliveryFile[];
  totals: PoDeliveryTotals;
  styles: DeliveryStyleRollup[];
} {
  const presentByKey = new Map<string, DeliveryFile>();
  for (const f of input.present) {
    const k = key(f.fileName);
    if (!presentByKey.has(k)) presentByKey.set(k, f);
  }

  // Group the expected MULTISET by the name each document wants.
  const groups = new Map<string, ExpectedFile[]>();
  for (const e of input.expected) {
    const k = key(e.fileName);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }

  // Every folder name some document accounts for, under EITHER of its names —
  // used to separate "stale copy of ours" from "not ours at all".
  const claimedNow = new Set<string>();
  const claimedPreviously = new Set<string>();
  for (const e of input.expected) {
    claimedNow.add(key(e.fileName));
    if (e.previousFileName) claimedPreviously.add(key(e.previousFileName));
  }

  const names: DeliveryNameGroup[] = [];
  const documents: DeliveryDocument[] = [];

  for (const [k, members] of groups) {
    const present = presentByKey.has(k);
    // A group is "present as previous" only when NONE of its members' current
    // name is there and at least one old name is — i.e. the whole group is
    // waiting on a rename, not on an upload.
    const presentAsPrevious =
      !present && members.some((m) => m.previousFileName != null && presentByKey.has(key(m.previousFileName)));

    const docs: DeliveryDocument[] = members.map((e) => {
      let status: DeliveryStatus;
      if (present) {
        // More than one claimant means the folder holds ONE of them and the
        // rest were overwritten. We cannot say which, so none of them gets to
        // claim "delivered".
        status = members.length > 1 ? "colliding" : "delivered";
      } else if (e.previousFileName && presentByKey.has(key(e.previousFileName))) {
        status = "renamed";
      } else {
        status = "missing";
      }
      return {
        styleId: e.styleId,
        styleName: e.styleName,
        variantKey: e.variantKey,
        name: e.name,
        docType: e.docType,
        jobAssetId: e.jobAssetId,
        fileName: e.fileName,
        previousFileName: e.previousFileName,
        status,
        queueItemId: e.queueItemId,
        queueStatus: e.queueStatus,
      };
    });

    documents.push(...docs);
    names.push({
      fileName: members[0].fileName,
      wanted: members.length,
      present,
      presentAsPrevious,
      documents: docs,
      distinguishers: members.length > 1 ? describeDistinguishers(docs) : [],
    });
  }

  // Sort worst first: a name nothing landed under matters more than a collision,
  // which matters more than a rename, which matters more than a clean row.
  const rank = (g: DeliveryNameGroup) =>
    !g.present && !g.presentAsPrevious ? 0 : g.wanted > 1 ? 1 : g.presentAsPrevious ? 2 : 3;
  names.sort((a, b) => rank(a) - rank(b) || a.fileName.localeCompare(b.fileName));

  // Files in the folder, split three ways.
  const staleFiles: DeliveryFile[] = [];
  const strayFiles: DeliveryFile[] = [];
  for (const f of input.present) {
    const k = key(f.fileName);
    if (claimedNow.has(k)) continue; // it is somebody's current name — accounted for
    if (claimedPreviously.has(k)) staleFiles.push(f);
    else strayFiles.push(f);
  }

  const collisionNames = names.filter((g) => g.wanted > 1).length;
  const collisionDocs = names.reduce((a, g) => a + (g.wanted > 1 ? g.wanted - 1 : 0), 0);

  const totals: PoDeliveryTotals = {
    expectedDocs: documents.length,
    // One document per present name is genuinely in the folder — including one
    // of each colliding group, which IS there even if we can't say which.
    deliveredDocs: names.filter((g) => g.present).length,
    renamedDocs: documents.filter((d) => d.status === "renamed").length,
    missingDocs: documents.filter((d) => d.status === "missing").length,
    collisionDocs,
    collisionNames,
    strayFiles: strayFiles.length,
    staleFiles: staleFiles.length,
  };

  // Per-style roll-up, in the order the styles first appear.
  const styleMap = new Map<string, DeliveryStyleRollup>();
  for (const d of documents) {
    const r = styleMap.get(d.styleId) ?? {
      styleId: d.styleId,
      styleName: d.styleName,
      expected: 0,
      delivered: 0,
    };
    r.expected += 1;
    if (d.status === "delivered") r.delivered += 1;
    styleMap.set(d.styleId, r);
  }

  return {
    names,
    documents,
    strayFiles,
    staleFiles,
    totals,
    styles: [...styleMap.values()].sort((a, b) => a.styleName.localeCompare(b.styleName)),
  };
}

// One line for a list view: "22 of 68 delivered". Kept here so the fleet list,
// the detail page and the cron's log all phrase it identically.
export function deliveryHeadline(totals: PoDeliveryTotals): string {
  const parts = [`${totals.deliveredDocs} of ${totals.expectedDocs} delivered`];
  if (totals.collisionDocs > 0) parts.push(`${totals.collisionDocs} can't land (name clash)`);
  if (totals.renamedDocs > 0) parts.push(`${totals.renamedDocs} under an old name`);
  if (totals.missingDocs > 0) parts.push(`${totals.missingDocs} missing`);
  return parts.join(" · ");
}

// Is this PO fully delivered? Deliberately NOT "missing === 0": a collision
// means a document can never land under the current naming, and a folder that
// silently drops artwork is not "ok" however few names are absent.
export function isFullyDelivered(totals: PoDeliveryTotals): boolean {
  return totals.expectedDocs > 0 && totals.missingDocs === 0 && totals.renamedDocs === 0 && totals.collisionDocs === 0;
}

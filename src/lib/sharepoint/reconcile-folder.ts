import {
  resolveSupplierFolder,
  findChildFolder,
  listChildFiles,
  listChildFolders,
  resolvePoFolder,
  renameDriveItem,
  deleteDriveItem,
  sanitizeFileName,
  SharePointWriteForbiddenError,
  type ChildFile,
} from "./supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";
import type { PoFolderMatch } from "./po-folder-matches";
import { isExpectedInSupplierFolder } from "@/lib/outputs/folder-expected";

// =====================================================
// Per-style, on-demand, BIDIRECTIONAL folder reconcile — "what is actually in
// the supplier's APPROVED LAYOUTS folder vs. what the CURRENT output config
// says should be there", both directions, for one style, right now.
//
// Why this exists next to the two sweeps that already touch these folders:
//
//   • verify-supplier-uploads.ts scans SupplierSendQueueItem rows that are
//     already sharePointStatus:"UPLOADED". It can therefore only ever ask "is
//     each file I THINK I uploaded still there?". An output added to the
//     ProdSpec AFTER approval has no queue row at all, so the sweep is blind to
//     it — there is nothing to scan. That is the `notQueued` bucket below and
//     it is the structural gap this module closes.
//   • fix-output-filenames.ts reconciles a file's name against its layout's
//     CURRENT template. It only looks at names it can derive; a file a HUMAN
//     renamed by hand is not a template drift and it never sees it.
//
// Neither computes the other direction — "there is a file here that nothing in
// the config accounts for" — even though both already hold the folder listing
// in memory when they run. That direction is where hand-renames show up, and
// it is the whole point of this module.
//
// TWO PROPERTIES THE FOLDER HAS THAT A NAIVE DIFF DOES NOT:
//
//   A. THE EXPECTED NAME IS THE TEMPLATE'S, NOT THE STAMP'S. An output is named
//      once, at generation, onto JobAsset.fileName. Edit the layout's fileName
//      template afterwards and that stamp goes stale — the runner will not
//      regenerate an approved output, so the new name never lands. Comparing
//      the folder against the STAMP therefore asks SharePoint about a name the
//      config stopped meaning. Expected names here come from
//      current-file-names.ts (the layout's template as it reads right now); the
//      stamp is kept alongside as `previousFileName`, and a document whose two
//      names disagree while the OLD one sits in the folder is its own bucket,
//      `renamed`. That is a repair, not a mystery, and it is the ONLY bucket
//      with a fully automatic fix (see repushRenamedFiles).
//
//   B. THE FOLDER IS PO-SCOPED; A STYLE IS NOT. One "<PO> - <customer> -
//      <supplier>" folder holds EVERY style on that PO — 1,582 of 2,625 live PO
//      folders hold more than one. Diffing the whole folder against ONE style's
//      config therefore reports every sibling style's perfectly good file as
//      "nothing accounts for this". The expected set is consequently the UNION
//      over every style that resolves to this same folder, tagged with its owner
//      so the panel can still lead with the style you are actually looking at.
//      `unexpected` then means what it claims: no style on this PO accounts for
//      it.
//
// (B) is also what makes (A)'s repair safe. push-to-supplier.ts assumes
// "filenames are style-number-prefixed, so styles never clobber each other" —
// which is false whenever two rows share a style number, and then the two styles
// overwrite each other in the shared folder. Deleting a stale-named file after
// re-pushing is only correct once we can see that NO OTHER style on the PO still
// expects that name; without the union we would be deleting a sibling's only
// copy. repushRenamedFiles refuses exactly that case.
//
// THREE deliberate differences from the sweeps, each load-bearing:
//
//   1. NOT gated on getSupplierBatchSendEnabled(). This is a read-only
//      diagnostic; the master switch being off is one of the reasons drift goes
//      unseen in the first place, so gating the diagnostic on it would hide
//      exactly what a user is trying to look at. The switch's state DOES ride
//      on the result (batchSendEnabled) because the *apply* actions below
//      depend on the upload sweep to actually move bytes — a re-arm with the
//      switch off sits at PENDING forever, and the UI has to say so.
//   2. No TTL, no budget, no 7-day sent window. Those exist to bound the cron's
//      Graph load. This runs once, when a human presses a button, on one style.
//      A file renamed three weeks after approval — permanently invisible to the
//      sweep because SENT_REVERIFY_WINDOW_MS has passed — shows up here.
//   3. It NEVER auto-repairs. When verify finds an expected name absent it
//      re-arms and the push re-uploads, which for a HAND-RENAMED file leaves
//      BOTH the human's copy and a fresh correct-named one in the folder. That
//      is precisely the failure this surface exists to let a human avoid, so
//      applying is always an explicit, itemised choice (see the two apply
//      helpers at the bottom).
//
// The folder is located EXACTLY the way the push and verify locate it —
// resolveSupplierFolder → listChildFolders → resolvePoFolder (honouring
// Style.supplierPoFolderName, the operator's manual pick) → the
// APPROVED_LAYOUTS_SUBFOLDER child. If these three ever disagreed about which
// folder is canonical they would fight: reconcile would report files missing
// that the push had just written somewhere else.
//
// UNRESOLVABLE-FOLDER DISCIPLINE (copied wholesale from verify): a 403, a
// throttle, a momentarily-unresolvable sharing link or an ambiguous PO folder
// must NEVER read as "the files are gone". Each gets its own state and NO diff
// is reported at all. Telling a user their approved artwork vanished because
// Graph blipped is worse than telling them nothing.
//
// Structure: everything above the "Graph I/O shell" banner is pure and unit
// tested (reconcile-folder.test.ts) — there are no credentials and no database
// in CI, so the diff, the rename similarity matcher and the state precedence
// are all pure functions over plain data.
// =====================================================

// -----------------------------------------------------
// Types
// -----------------------------------------------------

// Every terminal state of a reconcile. Only "ok" and "subfolder-missing" carry
// a meaningful diff; see reconcileStateMessage for what each one means and
// precheckReconcileState for the order they are decided in.
export type ReconcileState =
  | "ok" // folder found and listed — the diff below is real
  | "subfolder-missing" // PO folder found, no APPROVED LAYOUTS child yet → nothing was ever uploaded
  | "style-not-found"
  | "no-supplier" // no supplier linked on the style
  | "no-supplier-folder" // supplier linked, but no Supplier Folder link on file
  | "no-po" // no PO number → nothing to match a folder on
  | "skip-delivery" // customer delivers its own goods — nothing should be in a supplier folder
  | "not-configured" // SharePoint app credentials absent (local/dev)
  | "po-folder-missing" // no folder under the supplier root matches the PO
  | "po-folder-ambiguous" // several match — a human must pick; we must not guess
  | "unavailable"; // permission / transient Graph failure — NOT "the files are gone"

// One file the CURRENT output config says should be in the folder. Derived
// from getCurrentOutputsForStyle (config-driven), never from the queue — that
// is the whole point; a config-expected output with no queue row is a finding,
// not an absence of data.
export type ExpectedFile = {
  // The name the folder is compared against: the layout's CURRENT fileName
  // template, sanitised. Falls back to sanitize(storedFileName) when the
  // template can't be resolved for this document (see `nameNote`) — an
  // unresolvable template is a reason to keep asking about the old name, never
  // a reason to invent a new one.
  fileName: string;
  storedFileName: string; // JobAsset.fileName as stored (pre-sanitisation) — the name the push writes TODAY
  // sanitize(storedFileName) when it differs from `fileName` — i.e. the name
  // this document used to have and the folder may still be holding. null when
  // the template and the stamp agree, which is the ordinary case.
  previousFileName: string | null;
  // The un-sanitised current template result — what a restamp would write to
  // JobAsset.fileName. null when there is nothing to restamp to.
  currentStoredFileName: string | null;
  // Why the current name could not be resolved, when it could not. Surfaced
  // rather than swallowed: "we compared against the old name because the split
  // row is gone" is a different situation from "the names agree".
  nameNote: string | null;
  variantKey: string; // the DOCUMENT key ("<base>#<suffix>" for a split output)
  baseKey: string; // the SLOT key a queue row is keyed by
  name: string; // human display name of the output
  docType: string;
  jobAssetId: string;
  queueItemId: string | null; // null ⇒ never queued (the invisible-to-verify case)
  queueStatus: string | null; // SupplierSendQueueItem.sharePointStatus, when queued
  // ---- Owner. The folder is shared by every style on the PO, so each expected
  // file has to say whose it is; `isSelf` is the style whose page this is.
  styleId: string;
  styleName: string;
  isSelf: boolean;
};

// One file actually sitting in the folder right now.
export type PresentFile = {
  name: string; // exact on-SharePoint name
  itemId: string; // Graph item id — what renameDriveItem needs
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
};

// A similarity verdict linking one missing expected name to one unexpected
// present name. `confidence` is 0…1 — reported, never acted on automatically.
export type RenameGuess = { fileName: string; confidence: number };

// Every row the diff produces carries its owner, because the folder is shared
// by every style on the PO and a row's meaning depends on whose it is.
export type RowOwner = {
  styleId: string;
  styleName: string;
  isSelf: boolean;
};

export type MatchedRow = RowOwner & {
  fileName: string;
  variantKey: string;
  name: string;
  queueItemId: string | null;
  queueStatus: string | null;
  itemId: string;
  webUrl: string | null;
};

// The layout's fileName template changed after this document was generated, and
// the folder still holds the OLD name. Distinct from `missing` because the file
// is not gone — it is right there under a name the config has moved on from,
// and that is repairable end-to-end (restamp → re-push → delete the stale one).
export type RenamedRow = RowOwner & {
  fileName: string; // the name the template says it should have (sanitised)
  // The un-sanitised template result — what the repair writes back to
  // JobAsset.fileName so the push uploads under the new name. Always present on
  // a renamed row: the row only exists BECAUSE the template resolved to
  // something other than the stamp.
  currentStoredFileName: string;
  previousFileName: string; // the name it actually has in the folder right now
  variantKey: string;
  baseKey: string;
  name: string;
  jobAssetId: string;
  queueItemId: string | null;
  queueStatus: string | null;
  staleItemId: string; // Graph item id of the old-named file
  staleWebUrl: string | null;
  // Other styles on this PO whose CURRENT config still expects the old name.
  // Non-empty ⇒ the stale file is not ours alone to delete, and the repair
  // re-pushes but leaves it. Empty is the ordinary case.
  staleClaimedBy: Array<{ styleId: string; styleName: string }>;
};

export type MissingRow = RowOwner & {
  fileName: string;
  variantKey: string;
  baseKey: string;
  name: string;
  queued: boolean;
  queueItemId: string | null;
  queueStatus: string | null;
  // The unexpected file this one most plausibly became, if any.
  likelyRenamedTo: (RenameGuess & { itemId: string }) | null;
};

export type UnexpectedRow = {
  fileName: string;
  itemId: string;
  webUrl: string | null;
  size: number | null;
  lastModifiedAt: string | null;
  // The expected-but-missing output this file most plausibly IS, if any.
  likelyRenamedFrom: (RenameGuess & { variantKey: string; name: string } & RowOwner) | null;
};

export type NotQueuedRow = RowOwner & {
  fileName: string;
  variantKey: string;
  baseKey: string;
  name: string;
  docType: string;
  jobAssetId: string;
  present: boolean; // true ⇒ the file IS in the folder despite no queue row (a manual push)
};

export type FolderDiff = {
  ok: MatchedRow[];
  // Present under the OLD name after a template change. Ordered before
  // `missing` everywhere it is rendered: a renamed file is not a lost file, and
  // conflating the two is what sends someone hunting for artwork that is
  // sitting in front of them.
  renamed: RenamedRow[];
  missing: MissingRow[];
  unexpected: UnexpectedRow[];
  notQueued: NotQueuedRow[];
};

export type FolderReconcile = {
  styleId: string;
  styleName: string | null;
  poNumber: string | null;
  supplierName: string | null;
  state: ReconcileState;
  message: string; // one human sentence for `state`
  // How far folder resolution got — populated progressively, so even an
  // unresolvable state can say where we were looking.
  supplierFolderUrl: string | null;
  poFolderName: string | null;
  poFolderUrl: string | null;
  folderUrl: string | null; // the APPROVED LAYOUTS leaf itself
  folderPath: string | null; // "<PO folder> / APPROVED LAYOUTS", for the panel heading
  ambiguousMatches: PoFolderMatch[]; // populated only for "po-folder-ambiguous"
  expectedCount: number; // THIS style's expected documents
  presentCount: number;
  // ---- The rest of the PO. The folder belongs to the purchase order, not to
  // the style, so the panel has to be able to say "12 of these files are the
  // other style on this PO" instead of calling them unaccounted-for.
  poExpectedCount: number; // expected documents across EVERY style sharing this folder
  siblingStyles: Array<{ styleId: string; styleName: string; expected: number }>;
  // Styles on this PO that were NOT expanded because the cap was hit. Reported
  // rather than dropped: a silently truncated union would quietly turn a
  // sibling's files back into "unexpected", which is the bug this fixes.
  siblingsTruncated: number;
  // The diff. Empty (and MEANINGLESS) for every state except "ok" and
  // "subfolder-missing" — read `state` first, never the array lengths.
  diff: FolderDiff;
  // The supplierBatchSendEnabled master switch. A re-arm only queues the row;
  // the upload sweep is what moves bytes, and that IS gated on this — so with
  // the switch off a "Re-upload missing" does nothing visible until it is
  // turned on. The UI must say that rather than looking broken.
  batchSendEnabled: boolean;
  checkedAt: string; // ISO — this is a point-in-time snapshot, not a stored status
};

// -----------------------------------------------------
// Pure: filename similarity ("was this file renamed by hand?")
// -----------------------------------------------------

// Below this, a missing/unexpected pair is NOT called a rename. Tuned to be
// generous rather than strict: a false "likely renamed from X" costs a human
// two seconds of reading, a missed one costs them a duplicated file in a
// supplier's folder. Nothing is ever applied on this number alone.
export const RENAME_MATCH_THRESHOLD = 0.6;

// ".pdf" (lowercased, with the dot) or "" when the name has no extension. Used
// to refuse cross-type rename guesses: a PDF output is never the ZIP someone
// dropped in the folder, however similar the stems read.
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension; no dot at all → no extension.
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// Strip everything a human rename typically perturbs: case, extension, and any
// run of punctuation/whitespace (spaces vs hyphens vs underscores vs "(DE)"
// brackets) collapsed to a single space. What survives is the token spine of
// the name, which is what actually identifies the output.
export function normalizeFileNameForCompare(name: string): string {
  const stem = name.slice(0, name.length - fileExtension(name).length);
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Classic two-row Levenshtein. Names are capped at 250 chars by
// sanitizeFileName, so the O(n·m) worst case is trivially bounded here.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

// Sørensen–Dice over the two names' token SETS.
function tokenDice(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

// 0…1, how plausibly `a` and `b` are the same file under two names.
//
// Two measures, MAX of the pair, because the two realistic hand-rename shapes
// fail each other's metric:
//   • appended/removed words — "Wash care label (DE) FINAL.pdf" — barely dents
//     token overlap (0.89) but costs a lot of edit distance (0.75);
//   • a typo or reflowed separators — "Wash-care label DE.pdf" — keeps edit
//     distance high while splitting tokens apart.
// Taking the max means either shape is caught; the human sees the score and
// decides. A differing extension scores 0 outright — never guess across types.
export function fileNameSimilarity(a: string, b: string): number {
  if (fileExtension(a) !== fileExtension(b)) return 0;
  const na = normalizeFileNameForCompare(a);
  const nb = normalizeFileNameForCompare(b);
  if (na.length === 0 || nb.length === 0) return na === nb ? 1 : 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const editRatio = 1 - dist / Math.max(na.length, nb.length);
  return Math.max(editRatio, tokenDice(na, nb));
}

export type RenameMatch = { missing: string; unexpected: string; confidence: number };

// Pair up missing expected names with unexpected present names, best score
// first, each name used at most once (a file can only be one rename of one
// output). Greedy rather than optimal-assignment on purpose: the candidate sets
// are single digits, the scores are advisory, and a greedy pass is something a
// reviewer can reason about when it guesses wrong.
//
// Ties break on the names themselves so the output is deterministic — an
// advisory that reshuffles between two identical re-checks reads as a bug.
export function matchRenames(
  missing: string[],
  unexpected: string[],
  threshold: number = RENAME_MATCH_THRESHOLD,
): RenameMatch[] {
  const pairs: RenameMatch[] = [];
  for (const m of missing) {
    for (const u of unexpected) {
      const confidence = fileNameSimilarity(m, u);
      if (confidence >= threshold) pairs.push({ missing: m, unexpected: u, confidence });
    }
  }
  pairs.sort(
    (x, y) =>
      y.confidence - x.confidence ||
      x.missing.localeCompare(y.missing) ||
      x.unexpected.localeCompare(y.unexpected),
  );
  const usedMissing = new Set<string>();
  const usedUnexpected = new Set<string>();
  const out: RenameMatch[] = [];
  for (const p of pairs) {
    if (usedMissing.has(p.missing) || usedUnexpected.has(p.unexpected)) continue;
    usedMissing.add(p.missing);
    usedUnexpected.add(p.unexpected);
    out.push(p);
  }
  return out;
}

// -----------------------------------------------------
// Pure: the diff itself
// -----------------------------------------------------

// SharePoint folder names are case-insensitive, and the push writes
// sanitizeFileName(stored) — so the ONLY correct comparison key is the
// sanitised name lowercased. Verify makes exactly this comparison
// (`names.has(sanitizeFileName(n).toLowerCase())`); matching it here is what
// stops reconcile from reporting "missing" for a colon-bearing Output-Builder
// name that landed perfectly well as "…-layout-<id>-….pdf".
const compareKey = (fileName: string) => sanitizeFileName(fileName).toLowerCase();

// One entry per style, input order preserved — a style with five documents on
// the same collided name is one thing for a human to go and fix, not five.
function dedupeByStyle(rows: ExpectedFile[]): Array<{ styleId: string; styleName: string }> {
  const seen = new Set<string>();
  const out: Array<{ styleId: string; styleName: string }> = [];
  for (const r of rows) {
    if (seen.has(r.styleId)) continue;
    seen.add(r.styleId);
    out.push({ styleId: r.styleId, styleName: r.styleName });
  }
  return out;
}

// Pure diff of two file lists — no Graph, no DB, no clock. This is the whole
// decision logic of the module and is what the unit tests exercise.
//
// `expected` is the PO-WIDE union (every style sharing this folder), each row
// carrying its owner. That is load-bearing for `unexpected`: scoped to one
// style, a sibling's perfectly good file reads as unaccounted-for, and on live
// data most PO folders are shared.
//
// Five buckets, and note that `notQueued` is ORTHOGONAL to the other four:
//   • ok         — expected ∩ present, under the CURRENT template name.
//   • renamed    — the current name is absent but the document's PREVIOUS name
//                  (its JobAsset stamp, from before the template was edited) is
//                  present. The file is there; only the name is behind. Checked
//                  BEFORE `missing`, because a renamed file reported as missing
//                  sends someone hunting for artwork that never moved.
//   • missing    — expected ∖ present, under neither name. The config says this
//                  file belongs in the folder and it is not there.
//   • unexpected — present ∖ (every style's expected, old names included). A
//                  file NO style on this PO accounts for. Almost always a
//                  hand-rename (paired with a `missing` below), sometimes a
//                  supplier's own upload, occasionally an output removed from
//                  the ProdSpec whose file was never cleaned up.
//   • notQueued  — expected by the CURRENT config with NO SupplierSendQueueItem
//                  row behind it. This is a QUEUE-side finding, not a folder-side
//                  one: such a file is usually also `missing`, and deliberately
//                  appears in both. They call for different repairs — a missing
//                  row can be re-armed to PENDING, a never-queued output has no
//                  row to re-arm and needs a push (which re-derives the pushable
//                  set from the current config). A notQueued row that IS present
//                  carries present:true — someone pushed it by hand and the
//                  queue simply never learned.
export function diffFolderContents(input: {
  expected: ExpectedFile[];
  present: PresentFile[];
}): FolderDiff {
  const presentByKey = new Map<string, PresentFile>();
  // First writer wins: SharePoint cannot hold two files whose names differ only
  // by case in one folder, so a duplicate key here can only come from a caller
  // passing the same listing twice. Keeping the first keeps the result stable.
  for (const p of input.present) {
    const k = compareKey(p.name);
    if (!presentByKey.has(k)) presentByKey.set(k, p);
  }

  // Who still needs a given name — indexed under BOTH the name a document wants
  // today and the name it still carries in the folder. Drives `staleClaimedBy`,
  // and both halves are load-bearing on a collided PO:
  //
  //   • current name — a sibling whose config asks for that exact name; deleting
  //     it would remove a file that style is actively relying on.
  //   • previous name — a sibling whose OWN stale copy is that same file. Two
  //     styles that stamped identical names share ONE file in the folder, so it
  //     is the old copy of both, and it may only go once BOTH have been
  //     re-pushed under their new names.
  //
  // The happy consequence is that the stale file survives until the last style
  // stops needing it, and the repair says so instead of silently leaving it.
  const claimants = new Map<string, ExpectedFile[]>();
  const claim = (key: string, e: ExpectedFile) => {
    const arr = claimants.get(key) ?? [];
    arr.push(e);
    claimants.set(key, arr);
  };
  for (const e of input.expected) {
    claim(compareKey(e.fileName), e);
    if (e.previousFileName) claim(compareKey(e.previousFileName), e);
  }

  const ok: MatchedRow[] = [];
  const renamed: RenamedRow[] = [];
  const missingExpected: ExpectedFile[] = [];
  const matchedKeys = new Set<string>();

  const ownerOf = (e: ExpectedFile): RowOwner => ({
    styleId: e.styleId,
    styleName: e.styleName,
    isSelf: e.isSelf,
  });

  for (const e of input.expected) {
    const k = compareKey(e.fileName);
    const hit = presentByKey.get(k);
    if (hit) {
      matchedKeys.add(k);
      ok.push({
        ...ownerOf(e),
        fileName: e.fileName,
        variantKey: e.variantKey,
        name: e.name,
        queueItemId: e.queueItemId,
        queueStatus: e.queueStatus,
        itemId: hit.itemId,
        webUrl: hit.webUrl,
      });
      continue;
    }

    // The current name isn't there — is the name this document had BEFORE the
    // template was edited? Then nothing is lost, the folder is just behind.
    const prevKey = e.previousFileName ? compareKey(e.previousFileName) : null;
    const stale = prevKey ? presentByKey.get(prevKey) : undefined;
    if (prevKey && stale) {
      // The stale name is accounted for — it is this document under its old
      // name, NOT an unexplained file.
      matchedKeys.add(prevKey);
      renamed.push({
        ...ownerOf(e),
        fileName: e.fileName,
        // A renamed row can only arise when the template resolved (otherwise
        // fileName falls back to the stamp and previousFileName is null), so
        // this is non-null by construction — the fallback keeps the type honest
        // without inventing a name.
        currentStoredFileName: e.currentStoredFileName ?? e.fileName,
        previousFileName: e.previousFileName as string,
        variantKey: e.variantKey,
        baseKey: e.baseKey,
        name: e.name,
        jobAssetId: e.jobAssetId,
        queueItemId: e.queueItemId,
        queueStatus: e.queueStatus,
        staleItemId: stale.itemId,
        staleWebUrl: stale.webUrl,
        // Anyone ELSE still tied to that file — by name today, or as their own
        // un-repaired old copy. One entry per STYLE (a style with five documents
        // on the same collided name is one thing to go and fix, not five).
        staleClaimedBy: dedupeByStyle(
          (claimants.get(prevKey) ?? []).filter(
            (c) => c.jobAssetId !== e.jobAssetId && c.styleId !== e.styleId,
          ),
        ),
      });
      continue;
    }

    missingExpected.push(e);
  }

  const unexpectedPresent = input.present.filter((p) => !matchedKeys.has(compareKey(p.name)));

  // Similarity pass, run over the sanitised names so both sides are compared in
  // the same alphabet the folder actually uses.
  const guesses = matchRenames(
    missingExpected.map((e) => sanitizeFileName(e.fileName)),
    unexpectedPresent.map((p) => p.name),
  );
  const guessByMissing = new Map(guesses.map((g) => [g.missing, g]));
  const guessByUnexpected = new Map(guesses.map((g) => [g.unexpected, g]));

  const missing: MissingRow[] = missingExpected.map((e) => {
    const g = guessByMissing.get(sanitizeFileName(e.fileName));
    const target = g ? unexpectedPresent.find((p) => p.name === g.unexpected) : undefined;
    return {
      ...ownerOf(e),
      fileName: e.fileName,
      variantKey: e.variantKey,
      baseKey: e.baseKey,
      name: e.name,
      queued: e.queueItemId != null,
      queueItemId: e.queueItemId,
      queueStatus: e.queueStatus,
      likelyRenamedTo:
        g && target ? { fileName: target.name, confidence: g.confidence, itemId: target.itemId } : null,
    };
  });

  const unexpected: UnexpectedRow[] = unexpectedPresent.map((p) => {
    const g = guessByUnexpected.get(p.name);
    const source = g ? missingExpected.find((e) => sanitizeFileName(e.fileName) === g.missing) : undefined;
    return {
      fileName: p.name,
      itemId: p.itemId,
      webUrl: p.webUrl,
      size: p.size,
      lastModifiedAt: p.lastModifiedAt,
      likelyRenamedFrom:
        g && source
          ? {
              ...ownerOf(source),
              fileName: source.fileName,
              variantKey: source.variantKey,
              name: source.name,
              confidence: g.confidence,
            }
          : null,
    };
  });

  const notQueued: NotQueuedRow[] = input.expected
    .filter((e) => e.queueItemId == null)
    .map((e) => ({
      ...ownerOf(e),
      fileName: e.fileName,
      variantKey: e.variantKey,
      baseKey: e.baseKey,
      name: e.name,
      docType: e.docType,
      jobAssetId: e.jobAssetId,
      // Present under EITHER name — a document sitting there under its old name
      // was manifestly pushed by hand, and saying "not in the folder" because
      // the template moved on would be plainly wrong.
      present:
        presentByKey.has(compareKey(e.fileName)) ||
        (e.previousFileName != null && presentByKey.has(compareKey(e.previousFileName))),
    }));

  return { ok, renamed, missing, unexpected, notQueued };
}

// -----------------------------------------------------
// Pure: state precedence
// -----------------------------------------------------

// The states decidable BEFORE any Graph call, in the order they are checked.
// Order matters and is asserted in the tests: a style with neither a supplier
// nor a PO reads "no supplier linked" (the first broken link in the chain the
// user has to repair), not "no PO number" — telling someone to set a PO when
// there is no supplier to send it to sends them down the wrong path.
//
// Mirrors countPoFolderFiles' order (no-supplier → no-link → no-po →
// not-configured) so the "Supplier folder" panel's file count and this panel
// can never disagree about which link in the chain is broken, with the
// customer's skip-supplier-delivery gate slotted in ahead of the SharePoint
// config check: if the customer delivers its own goods there is deliberately
// nothing in any supplier folder, and that is true whether or not Graph is
// configured. Returns null when nothing blocks and we should go to Graph.
export function precheckReconcileState(input: {
  styleFound: boolean;
  hasSupplier: boolean;
  supplierFolderUrl: string | null;
  poNumber: string | null;
  skipSupplierDelivery: boolean;
  sharepointConfigured: boolean;
}): ReconcileState | null {
  if (!input.styleFound) return "style-not-found";
  if (!input.hasSupplier) return "no-supplier";
  if (!input.supplierFolderUrl || !input.supplierFolderUrl.trim()) return "no-supplier-folder";
  if (!input.poNumber || !input.poNumber.trim()) return "no-po";
  if (input.skipSupplierDelivery) return "skip-delivery";
  if (!input.sharepointConfigured) return "not-configured";
  return null;
}

// One human sentence per state. Kept here (not in the panel) so the API, any
// future CLI and the UI all say the same thing about the same situation.
export function reconcileStateMessage(
  state: ReconcileState,
  ctx?: { supplierName?: string | null; poNumber?: string | null; missingEnvVars?: string[] },
): string {
  const supplier = ctx?.supplierName ? `“${ctx.supplierName}”` : "the supplier";
  const po = ctx?.poNumber ? `“${ctx.poNumber}”` : "this style's PO";
  switch (state) {
    case "ok":
      return "Folder listed — the comparison below is live.";
    case "subfolder-missing":
      return `The PO folder exists but has no “${APPROVED_LAYOUTS_SUBFOLDER}” subfolder yet, so nothing has ever been uploaded into it. The push creates it on the first upload.`;
    case "style-not-found":
      return "Style not found.";
    case "no-supplier":
      return "No supplier is linked to this style (Pre-Order board · “Supplier”), so there is no folder to compare against.";
    case "no-supplier-folder":
      return `Supplier ${supplier} has no Supplier Folder link on the Monday Suppliers board — nothing to open, so nothing can be compared.`;
    case "no-po":
      return "This style has no PO number, and the PO folder is found by matching that number — nothing can be compared.";
    case "skip-delivery":
      return "This customer delivers its own goods (skipSupplierDelivery), so nothing is ever pushed to a supplier folder for this style.";
    case "not-configured":
      // Name the variables. The previous wording sent people looking for
      // "SharePoint credentials" in an environment that HAD working ones — the
      // gate was asking for a site id this path never uses (see auth.ts).
      return (
        "Microsoft Graph credentials aren't configured in this environment, so the folder can't be listed" +
        (ctx?.missingEnvVars?.length ? ` — missing ${ctx.missingEnvVars.join(", ")}.` : ".")
      );
    case "po-folder-missing":
      return `No folder matching PO ${po} exists in ${supplier}'s SharePoint. The app never creates the PO folder — an employee must, and uploads then land on the next sweep.`;
    case "po-folder-ambiguous":
      return `Several folders in ${supplier}'s SharePoint match PO ${po}. There must be exactly one; until a human picks (or deletes the extras) we can't say which folder these files belong in — so no comparison is shown.`;
    case "unavailable":
      return "SharePoint couldn't be read just now (permission or a transient error). Nothing is reported as missing — a failed lookup is not evidence that a file is gone. Try Re-check in a moment.";
  }
}

// -----------------------------------------------------
// Graph I/O shell — everything below talks to Graph and/or the database.
// Deliberately thin: resolve, list, hand the two lists to the pure diff.
// -----------------------------------------------------

// The DB, current-outputs, app-settings and isSharepointConfigured are all
// lazy-imported, matching current-outputs.ts and the verify sweep's own lazy
// import of it. Beyond the cycle-avoidance those have, it keeps this module
// importable — and therefore its pure half unit testable — without a
// DATABASE_URL: db.ts constructs the Prisma client at module scope and throws
// without one, and publish-approved-job.ts (where isSharepointConfigured lives,
// shared with the PO-folder file count so the two agree) pulls in that whole
// graph transitively.

// isGraphConfigured, NOT publish-approved-job's isSharepointConfigured: this
// module reaches the folder through a sharing link and never touches
// SHAREPOINT_SITE_ID, so requiring it reported "not configured" in an
// environment where every Graph call here works fine. See auth.ts.
async function sharepointConfigured(): Promise<boolean> {
  const { isGraphConfigured } = await import("./auth");
  return isGraphConfigured();
}

export type StyleRow = {
  id: string;
  name: string;
  poNumber: string | null;
  supplierId: string | null;
  supplierPoFolderName: string | null;
  supplierName: string | null;
  supplierFolderUrl: string | null;
  skipSupplierDelivery: boolean;
};

async function loadStyle(styleId: string): Promise<StyleRow | null> {
  const { db } = await import("@/lib/db");
  const { parseCustomerConfig } = await import("@/lib/customers/config");
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      id: true,
      name: true,
      poNumber: true,
      supplierId: true, // the folder is (supplier root → PO folder); both halves scope the siblings
      supplierPoFolderName: true, // the operator's manual pick — same input the push/verify use
      customer: { select: { config: true } },
      supplier: { select: { name: true, sharepointUrl: true } },
    },
  });
  if (!style) return null;
  return {
    id: style.id,
    name: style.name,
    poNumber: style.poNumber,
    supplierId: style.supplierId,
    supplierPoFolderName: style.supplierPoFolderName,
    supplierName: style.supplier?.name ?? null,
    supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
    skipSupplierDelivery: parseCustomerConfig(style.customer.config).skipSupplierDelivery,
  };
}

// How many styles' configs one reconcile will expand. Each costs a
// current-outputs walk and a render context, so this is a real bound — but the
// live maximum for one (supplier, PO) is 14, so it is headroom rather than a
// limit anyone should hit. Whatever it cuts is REPORTED (siblingsTruncated),
// never silently dropped: a truncated union turns a sibling's files back into
// "unexpected", which is the exact bug this expansion exists to fix.
const MAX_SIBLING_STYLES = 20;

// Every OTHER style that lands in this same PO folder.
//
// Scoped on (supplierId, poNumber) because that pair is what the folder
// resolution is keyed on — same PO number under a different supplier is a
// different supplier root and therefore a different folder entirely.
//
// The supplierPoFolderName filter is deliberately INCLUSIVE: a sibling that
// pinned a different folder by hand is genuinely elsewhere and is excluded, but
// a sibling with no pin (the overwhelmingly common case) resolves by PO match —
// and the folder we resolved IS a PO match — so it is treated as sharing. The
// asymmetry is on purpose. Wrongly including a style means we might not flag a
// genuinely stray file; wrongly excluding one means we call its good files
// suspicious. The second is the failure being fixed here, so bias to inclusion.
async function loadSiblingStyles(
  self: StyleRow,
  resolvedPoFolderName: string | null,
): Promise<{ styles: Array<{ id: string; name: string }>; truncated: number }> {
  if (!self.poNumber || !self.supplierId) return { styles: [], truncated: 0 };
  const { db } = await import("@/lib/db");

  const rows = await db.style.findMany({
    where: {
      id: { not: self.id },
      poNumber: self.poNumber,
      supplierId: self.supplierId,
      archivedAt: null,
      deletedAt: null,
    },
    select: { id: true, name: true, supplierPoFolderName: true },
    orderBy: { name: "asc" },
  });

  const sharing = rows.filter(
    (r) =>
      !r.supplierPoFolderName ||
      !resolvedPoFolderName ||
      r.supplierPoFolderName.trim().toLowerCase() === resolvedPoFolderName.trim().toLowerCase(),
  );

  return {
    styles: sharing.slice(0, MAX_SIBLING_STYLES).map((r) => ({ id: r.id, name: r.name })),
    truncated: Math.max(0, sharing.length - MAX_SIBLING_STYLES),
  };
}

// The CONFIG-DRIVEN expected set — the answer to the user's "what SHOULD be
// uploaded due to the current output config", which is exactly what the
// queue-driven verify sweep cannot ask.
//
// The filter is verify's filter, character for character (approved, no
// placeholders, has an asset, has a fileName), because the three surfaces have
// to agree on what belongs in the folder or they will fight over it. Note this
// does NOT carry push-to-supplier's cover exception (a cover ships regardless
// of its own review status): covers reach the folder through the queue, and the
// queue path — enqueueApprovedAsset, the upload sweep's slot expansion and
// verify — all require APPROVED, so mirroring the direct push's exception here
// would report an unapproved cover as "missing" against a queue that never
// intended to send it.
//
// Queue rows are keyed by the SLOT (base variantKey); a split output is many
// documents behind one row. So `queueItemId` is looked up per base and shared
// by every document of that slot, exactly as verify expands slot → documents.
//
// `fileName` is resolved from the layout's CURRENT template, not from the
// JobAsset stamp — see (A) in the header. The stamp is kept as
// `previousFileName` whenever the two disagree, which is what lets the diff say
// "it's there, under the old name" instead of "it's gone".
export async function loadExpectedFiles(
  style: { id: string; name: string },
  isSelf: boolean,
  variantsAlreadyFresh: boolean,
): Promise<ExpectedFile[]> {
  const { db } = await import("@/lib/db");
  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
  const { resolveCurrentFileNames } = await import("./current-file-names");

  const [outputs, queueRows] = await Promise.all([
    getCurrentOutputsForStyle(style.id),
    db.supplierSendQueueItem.findMany({
      where: { styleId: style.id },
      select: { id: true, variantKey: true, sharePointStatus: true },
    }),
  ]);

  const queueByBase = new Map(queueRows.map((r) => [r.variantKey, r]));

  // One shared answer to "does this belong in the folder?" — see
  // isExpectedInSupplierFolder. It is the approval rule PLUS the cover, which
  // ships unapproved by design; spelling the rule out inline here is what used
  // to leave the cover out of every folder audit.
  //
  // NOTE verify-supplier-uploads.ts deliberately still applies the narrower
  // approval-only filter. It is the AUTOMATIC self-heal (it re-arms a row whose
  // file it cannot find, and the push sweep then uploads it), so admitting
  // covers there would re-upload every cover whose name changed and leave the
  // old-named file behind — the orphan the rename-in-place sweep exists to
  // avoid. It should adopt this predicate once the cover renames have been run
  // through "Fix output filenames".
  const deliverable = outputs.filter(isExpectedInSupplierFolder);

  // Resolving current names needs the style's render context, which can fail
  // (a style whose Monday data went away, a layout mid-publish). That must NOT
  // sink the reconcile: with no template answers every document simply keeps
  // its stamped name, which is exactly the pre-existing behaviour.
  let currentNames: Awaited<ReturnType<typeof resolveCurrentFileNames>> = new Map();
  try {
    currentNames = await resolveCurrentFileNames(
      style.id,
      deliverable.map((o) => ({ jobAssetId: o.jobAssetId as string, variantKey: o.variantKey })),
      { variantsAlreadyFresh },
    );
  } catch (err) {
    console.warn(`[folder-reconcile] current-name resolution failed for style ${style.id}:`, err);
  }

  const expected: ExpectedFile[] = [];
  for (const o of deliverable) {
    const jobAssetId = o.jobAssetId as string;
    const stored = o.fileName as string;
    const baseKey = o.variantKey.split("#")[0] || `doc:${o.docType}`;
    const row = queueByBase.get(baseKey);

    const resolution = currentNames.get(jobAssetId);
    const currentStored = resolution?.kind === "resolved" ? resolution.fileName : null;
    // No current answer ⇒ keep asking about the stamped name. Never invent one.
    const fileName = sanitizeFileName(currentStored ?? stored);
    const storedSanitised = sanitizeFileName(stored);

    expected.push({
      fileName,
      storedFileName: stored,
      previousFileName: storedSanitised.toLowerCase() === fileName.toLowerCase() ? null : storedSanitised,
      currentStoredFileName: currentStored,
      nameNote: resolution?.kind === "unresolvable" ? resolution.reason : null,
      variantKey: o.variantKey,
      baseKey,
      name: o.name,
      docType: o.docType,
      jobAssetId,
      queueItemId: row?.id ?? null,
      queueStatus: row?.sharePointStatus ?? null,
      styleId: style.id,
      styleName: style.name,
      isSelf,
    });
  }
  return expected;
}

// The PO-WIDE expected set: this style plus every sibling sharing the folder.
//
// The layout-variant force-refresh happens ONCE here and every per-style
// resolution is told it is already fresh — it re-reads every published layout,
// and paying that per sibling would make a shared PO folder measurably slower
// for no gain.
//
// A sibling whose expected set throws is skipped rather than fatal: failing to
// read style B must not stop the user from seeing style A's diff. The cost is
// that B's files may show as unexpected, which is the status quo, not a
// regression.
async function loadPoFolderExpected(
  self: StyleRow,
  resolvedPoFolderName: string | null,
): Promise<{
  expected: ExpectedFile[];
  selfCount: number;
  siblingStyles: Array<{ styleId: string; styleName: string; expected: number }>;
  siblingsTruncated: number;
}> {
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  await ensureLayoutVariantsLoaded(true);

  const selfExpected = await loadExpectedFiles({ id: self.id, name: self.name }, true, true);

  const { styles: siblings, truncated } = await loadSiblingStyles(self, resolvedPoFolderName);
  const expected = [...selfExpected];
  const siblingStyles: Array<{ styleId: string; styleName: string; expected: number }> = [];

  for (const sib of siblings) {
    try {
      const rows = await loadExpectedFiles(sib, false, true);
      expected.push(...rows);
      siblingStyles.push({ styleId: sib.id, styleName: sib.name, expected: rows.length });
    } catch (err) {
      console.warn(`[folder-reconcile] sibling ${sib.id} expected-set failed:`, err);
      siblingStyles.push({ styleId: sib.id, styleName: sib.name, expected: 0 });
    }
  }

  return { expected, selfCount: selfExpected.length, siblingStyles, siblingsTruncated: truncated };
}

const EMPTY_DIFF: FolderDiff = { ok: [], renamed: [], missing: [], unexpected: [], notQueued: [] };

// Where a resolution attempt landed, plus the leaf we can list (when we got
// that far). Shared by the read path and by adopt's re-resolution so the two
// can never disagree about which folder they are acting on.
export type FolderTarget = {
  state: ReconcileState;
  supplierFolderUrl: string | null;
  poFolderName: string | null;
  poFolderUrl: string | null;
  folderUrl: string | null;
  driveId: string | null;
  leafItemId: string | null;
  ambiguousMatches: PoFolderMatch[];
};

// resolveSupplierFolder → listChildFolders → resolvePoFolder → APPROVED LAYOUTS.
// The same chain, in the same order, as push-to-supplier and
// verify-supplier-uploads. Every throw is caught and mapped to "unavailable" —
// a 403/throttle/blip is never allowed to become a claim about file presence.
export async function resolveApprovedLayoutsFolder(style: StyleRow): Promise<FolderTarget> {
  const base: FolderTarget = {
    state: "ok",
    supplierFolderUrl: null,
    poFolderName: null,
    poFolderUrl: null,
    folderUrl: null,
    driveId: null,
    leafItemId: null,
    ambiguousMatches: [],
  };

  let root;
  try {
    root = await resolveSupplierFolder(style.supplierFolderUrl as string);
  } catch {
    return { ...base, state: "unavailable" };
  }
  base.supplierFolderUrl = root.webUrl;
  base.driveId = root.driveId;

  let resolution;
  try {
    const children = await listChildFolders(root.driveId, root.itemId);
    resolution = resolvePoFolder(children, style.poNumber, style.supplierPoFolderName);
  } catch {
    return { ...base, state: "unavailable" };
  }

  if (resolution.status === "ambiguous") {
    // Never auto-pick. Hand back every candidate (name + link) so the panel can
    // route the user at the existing PO-folder picker instead of guessing.
    return {
      ...base,
      state: "po-folder-ambiguous",
      ambiguousMatches: resolution.matches.map((m) => ({ name: m.name, webUrl: m.webUrl })),
    };
  }
  if (resolution.status === "missing") return { ...base, state: "po-folder-missing" };

  base.poFolderName = resolution.folder.name;
  base.poFolderUrl = resolution.folder.webUrl;

  let leaf;
  try {
    leaf = await findChildFolder(root.driveId, resolution.folder.id, APPROVED_LAYOUTS_SUBFOLDER);
  } catch {
    return { ...base, state: "unavailable" };
  }
  // A genuinely absent subfolder IS a conclusion, not a failure: the push
  // get-or-creates it on the first upload, so its absence means nothing has
  // ever been uploaded here. Verify draws the same conclusion (folderExists =
  // false → the file is not present).
  if (!leaf) return { ...base, state: "subfolder-missing" };

  base.folderUrl = leaf.webUrl;
  base.leafItemId = leaf.id;
  return base;
}

const folderPathOf = (t: FolderTarget) =>
  t.poFolderName ? `${t.poFolderName} / ${APPROVED_LAYOUTS_SUBFOLDER}` : null;

// READ-ONLY. Runs the full bidirectional reconcile for one style and returns a
// UI-ready result. Mutates nothing, ever — the apply helpers below are the only
// things in this module that write.
export async function reconcileStyleFolder(styleId: string): Promise<FolderReconcile> {
  return (await runReconcile(styleId)).result;
}

// The reconcile, plus the resolution it used. `adoptRenamedFile` needs BOTH —
// the diff to validate what it was asked to do, and the (driveId, leaf) it was
// computed against to do it. Re-resolving the folder for the write would open a
// window where the rename lands somewhere the diff never looked, so the two
// share one resolution pass.
async function runReconcile(
  styleId: string,
): Promise<{ result: FolderReconcile; target: FolderTarget | null; style: StyleRow | null }> {
  const { getSupplierBatchSendEnabled } = await import("@/lib/settings/app-settings");
  // Read the master switch even though we do NOT gate on it: the result has to
  // be able to tell the user that a re-arm will sit idle until it is on.
  // Fail-soft — a settings hiccup must not sink a read-only diagnostic.
  const batchSendEnabled = await getSupplierBatchSendEnabled().catch(() => false);
  const style = await loadStyle(styleId);
  // Named in the "not configured" message so the next person sees WHICH
  // variable is absent rather than a blanket claim about credentials.
  const { missingGraphEnvVars } = await import("./auth");
  const missingEnvVars = missingGraphEnvVars();

  const shell = (state: ReconcileState, extra?: Partial<FolderReconcile>): FolderReconcile => ({
    styleId,
    styleName: style?.name ?? null,
    poNumber: style?.poNumber ?? null,
    supplierName: style?.supplierName ?? null,
    state,
    message: reconcileStateMessage(state, {
      supplierName: style?.supplierName,
      poNumber: style?.poNumber,
      missingEnvVars,
    }),
    supplierFolderUrl: null,
    poFolderName: null,
    poFolderUrl: null,
    folderUrl: null,
    folderPath: null,
    ambiguousMatches: [],
    expectedCount: 0,
    presentCount: 0,
    poExpectedCount: 0,
    siblingStyles: [],
    siblingsTruncated: 0,
    diff: EMPTY_DIFF,
    batchSendEnabled,
    checkedAt: new Date().toISOString(),
    ...extra,
  });

  const blocked = precheckReconcileState({
    styleFound: style != null,
    hasSupplier: style?.supplierName != null,
    supplierFolderUrl: style?.supplierFolderUrl ?? null,
    poNumber: style?.poNumber ?? null,
    skipSupplierDelivery: style?.skipSupplierDelivery ?? false,
    sharepointConfigured: await sharepointConfigured(),
  });
  if (blocked) return { result: shell(blocked), target: null, style };
  const resolved = style as StyleRow;

  const target = await resolveApprovedLayoutsFolder(resolved);
  const located = {
    supplierFolderUrl: target.supplierFolderUrl,
    poFolderName: target.poFolderName,
    poFolderUrl: target.poFolderUrl,
    folderUrl: target.folderUrl,
    folderPath: folderPathOf(target),
    ambiguousMatches: target.ambiguousMatches,
  };
  // Every non-listable state stops here WITHOUT a diff. An empty diff and a
  // 403 must never render the same way.
  if (target.state !== "ok" && target.state !== "subfolder-missing") {
    return { result: shell(target.state, located), target, style: resolved };
  }

  // The expected set is worth computing even for "subfolder-missing": knowing
  // six approved outputs are waiting on a folder that was never created is far
  // more useful than "nothing to show".
  let po: Awaited<ReturnType<typeof loadPoFolderExpected>>;
  try {
    po = await loadPoFolderExpected(resolved, target.poFolderName);
  } catch (err) {
    // Can't say what SHOULD be there ⇒ can't say anything is missing.
    console.warn(`[folder-reconcile] expected-set resolution failed for style ${styleId}:`, err);
    return { result: shell("unavailable", located), target, style: resolved };
  }
  const expected = po.expected;

  let present: ChildFile[] = [];
  if (target.state === "ok") {
    try {
      present = await listChildFiles(target.driveId as string, target.leafItemId as string);
    } catch {
      return { result: shell("unavailable", located), target, style: resolved };
    }
  }

  const diff = diffFolderContents({
    expected,
    present: present.map((f) => ({
      name: f.name,
      itemId: f.id,
      webUrl: f.webUrl,
      size: f.size,
      lastModifiedAt: f.lastModifiedAt,
    })),
  });

  return {
    result: shell(target.state, {
      ...located,
      // expectedCount stays THIS style's document count — the headline on a
      // style page must keep answering "how many of MY files should be here".
      // The PO-wide total rides alongside it.
      expectedCount: po.selfCount,
      presentCount: present.length,
      poExpectedCount: expected.length,
      siblingStyles: po.siblingStyles,
      siblingsTruncated: po.siblingsTruncated,
      diff,
    }),
    target,
    style: resolved,
  };
}

// -----------------------------------------------------
// Apply — one explicit, itemised action at a time. Never "fix everything".
// -----------------------------------------------------

export type RearmResult = {
  rearmed: number;
  queueItemIds: string[];
  // Echoes the master switch: with it OFF the rows are re-armed but the upload
  // sweep — which is gated on it — will not run, so nothing moves yet.
  batchSendEnabled: boolean;
};

// Re-arm named queue rows to PENDING so the upload sweep re-uploads them.
//
// The data written is IDENTICAL to the verify sweep's self-heal (status
// PENDING, pushAttempts 0, url + folderUrl + verifiedAt cleared, queuedAt
// refreshed so a already-sent row gets a fresh retry lease under
// SENT_RETRY_LEASE_MS). Deliberately so: two different "re-arm" shapes would
// mean a row healed here and a row healed by the cron behave differently in the
// push sweep. sentAt is left alone for verify's reason — the supplier was
// already told about this output; the file just needs to actually be there.
//
// Ids are scoped to the style server-side so a queue id from another style
// cannot be smuggled in through the request body (same defence as the per-style
// push route recomputing its own asset set).
export async function rearmMissingUploads(input: {
  styleId: string;
  queueItemIds: string[];
  userId?: string;
}): Promise<RearmResult> {
  const { db } = await import("@/lib/db");
  const { getSupplierBatchSendEnabled } = await import("@/lib/settings/app-settings");
  const batchSendEnabled = await getSupplierBatchSendEnabled().catch(() => false);

  const ids = [...new Set(input.queueItemIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { rearmed: 0, queueItemIds: [], batchSendEnabled };

  const owned = await db.supplierSendQueueItem.findMany({
    where: { id: { in: ids }, styleId: input.styleId },
    select: { id: true },
  });
  if (owned.length === 0) return { rearmed: 0, queueItemIds: [], batchSendEnabled };
  const ownedIds = owned.map((r) => r.id);

  const now = new Date();
  const res = await db.supplierSendQueueItem.updateMany({
    where: { id: { in: ownedIds } },
    data: {
      sharePointStatus: "PENDING",
      pushAttempts: 0,
      sharePointUrl: null,
      sharePointFolderUrl: null,
      sharePointVerifiedAt: null,
      queuedAt: now,
    },
  });

  await writeAuditLog(
    input.styleId,
    `folder reconcile: re-armed ${res.count} queued output(s) for re-upload` +
      (batchSendEnabled ? "" : " — supplier batch sending is OFF, so nothing uploads until it is switched on") +
      (input.userId ? ` · by user ${input.userId}` : ""),
  );

  return { rearmed: res.count, queueItemIds: ownedIds, batchSendEnabled };
}

export type AdoptResult = {
  adopted: boolean;
  fromFileName: string;
  toFileName: string;
  webUrl: string | null;
  note?: string;
};

// Adopt a hand-renamed file: PATCH it back to the name the current config
// expects (renameDriveItem — same item, same bytes, same version history, the
// non-destructive move fix-output-filenames already relies on).
//
// This is the answer to the duplicate-file problem in the header: verify's
// automatic response to an absent expected name is re-upload, which leaves the
// human's renamed copy AND a fresh correct-named one side by side. Renaming the
// existing file instead leaves exactly one.
//
// Both arguments are RE-VALIDATED against a FRESH reconcile rather than trusted
// from the request: `itemId` must currently be an unexpected file in this
// style's folder, and `toFileName` must currently be an expected-but-missing
// name. Between the GET a user looked at and the POST they clicked, a sweep may
// have re-uploaded the file, an operator may have fixed the name by hand, or
// the ProdSpec may have changed — every one of which turns this rename into
// data loss. The re-check costs a few Graph reads on a manual action.
//
// That fresh reconcile also hands back the (driveId, leaf) it was computed
// against, and the rename is issued against THAT — resolving the folder a
// second time for the write could land the PATCH in a folder the diff never
// looked at (an operator picking a different PO folder mid-request).
//
// No DB write is needed on success: the file now carries the expected name, so
// the next verify pass finds it present and stamps the row verified. If the row
// happens to be PENDING (an earlier verify heal), the push re-uploading the
// same bytes over the same name is idempotent.
export async function adoptRenamedFile(input: {
  styleId: string;
  itemId: string;
  toFileName: string;
  userId?: string;
}): Promise<AdoptResult> {
  const { result: current, target } = await runReconcile(input.styleId);
  // Anything but a fully-listed folder means we can't be sure what we'd be
  // renaming, or renaming it onto — refuse and say why, in the state's own
  // words (no supplier, 403, ambiguous PO folder, …).
  if (current.state !== "ok" || !target || !target.driveId) {
    throw new ReconcileApplyError(409, current.message);
  }

  const unexpected = current.diff.unexpected.find((u) => u.itemId === input.itemId);
  if (!unexpected) {
    throw new ReconcileApplyError(
      409,
      "That file is no longer an unexpected file in this folder — re-check before adopting (it may already have been renamed or removed).",
    );
  }
  // Scoped to THIS style's rows: the diff is PO-wide now, and adopting a file
  // onto a SIBLING style's expected name from this style's page would be a
  // cross-style write the user never asked for. Repairing a sibling means
  // opening the sibling, where its own diff is the one on screen.
  const missing = current.diff.missing.find(
    (m) =>
      m.isSelf &&
      sanitizeFileName(m.fileName).toLowerCase() === sanitizeFileName(input.toFileName).toLowerCase(),
  );
  if (!missing) {
    const elsewhere = current.diff.missing.find(
      (m) => sanitizeFileName(m.fileName).toLowerCase() === sanitizeFileName(input.toFileName).toLowerCase(),
    );
    throw new ReconcileApplyError(
      409,
      elsewhere
        ? `That name belongs to “${elsewhere.styleName}”, another style sharing this PO folder — open that style to adopt it there.`
        : "That target name is not currently an expected-but-missing output for this style — re-check before adopting.",
    );
  }

  const newName = sanitizeFileName(missing.fileName);
  let res;
  try {
    res = await renameDriveItem(target.driveId, input.itemId, newName);
  } catch (err) {
    if (err instanceof SharePointWriteForbiddenError) {
      throw new ReconcileApplyError(403, `${err.message}. Ask FLC to enable write on Contrast-Suppliers, then retry.`);
    }
    throw err;
  }

  if (res.notFound) {
    throw new ReconcileApplyError(409, "The file vanished before it could be renamed — re-check the folder.");
  }
  if (res.conflict) {
    // A file with the target name appeared between the diff and the PATCH
    // (almost always the upload sweep re-uploading it). Deleting the human's
    // copy is NOT this action's call to make — say so and let them decide.
    throw new ReconcileApplyError(
      409,
      `A file called “${newName}” already exists in the folder — it was probably re-uploaded in the meantime. Re-check: you now have both copies and can delete the stale one in SharePoint.`,
    );
  }

  await writeAuditLog(
    input.styleId,
    `folder reconcile: adopted hand-renamed file “${unexpected.fileName}” → “${newName}” (${missing.variantKey})` +
      (input.userId ? ` · by user ${input.userId}` : ""),
  );

  return { adopted: true, fromFileName: unexpected.fileName, toFileName: newName, webUrl: res.webUrl ?? null };
}

export type RepushOutcome = {
  jobAssetId: string;
  variantKey: string;
  name: string;
  fromFileName: string; // the stale name it had in the folder
  toFileName: string; // the name it now has
  pushed: boolean;
  webUrl: string | null;
  staleDeleted: boolean;
  // Populated when the stale file was deliberately LEFT — who still needs it.
  staleLeftBecause: string | null;
};

export type RepushResult = {
  repaired: number;
  pushed: number;
  staleDeleted: number;
  staleLeft: number;
  items: RepushOutcome[];
};

// Repair documents whose layout template was renamed after they were approved:
// restamp the stored name, RE-PUSH the approved bytes under it, then remove the
// copy sitting there under the old name.
//
// WHY RE-PUSH RATHER THAN RENAME IN PLACE. fix-output-filenames.ts repairs this
// class of drift with a Graph PATCH — cheaper, keeps version history — and that
// is the right move when the folder holds exactly one style's work. It is the
// WRONG move here. Two styles sharing a PO and a style number stamp identical
// names and overwrite each other in the shared folder, so the file called
// "EV30068-S-Care-Label.pdf" may be either style's artwork and NOTHING in the
// name says which. Renaming it would put one style's PDF under the other's
// name — the exact failure the reviewer would never catch. Re-pushing takes the
// bytes from JobAsset.pdf, which is unambiguously this document's own artwork.
//
// WHY NO REGENERATION. The PDFs are already correct and already approved; only
// their names went stale. Regenerating would send every one of them back to
// PENDING_REVIEW for no gain. Bytes, approval and review history are untouched.
//
// ORDER IS THE SAFETY PROPERTY: restamp → upload the new name → only then delete
// the old one. The supplier's folder never passes through a state where the
// document is absent. A push that fails leaves the stale file exactly where it
// was, which is why the delete is a separate, later step and not a rollback.
//
// The delete is refused outright while ANY other style on the PO is still tied
// to that file (staleClaimedBy) — see the diff's claimant index. Repair those
// styles too and the last one through takes the file with it.
export async function repushRenamedFiles(input: {
  styleId: string;
  jobAssetIds: string[];
  userId?: string;
}): Promise<RepushResult> {
  const { db } = await import("@/lib/db");
  const { pushApprovedAssetsToSupplier } = await import("./push-to-supplier");

  // Re-validate against a FRESH reconcile rather than trusting the request:
  // between the GET a user looked at and the POST they clicked, a sweep may
  // have re-uploaded the file, someone may have fixed the name by hand, or the
  // ProdSpec may have changed. Same discipline as adoptRenamedFile.
  const { result: current, target } = await runReconcile(input.styleId);
  if (current.state !== "ok" || !target || !target.driveId || !target.leafItemId) {
    throw new ReconcileApplyError(409, current.message);
  }

  const wanted = new Set(input.jobAssetIds.filter((id) => typeof id === "string" && id.length > 0));
  // Scoped to THIS style server-side, so an id from a sibling on the same PO
  // can't be smuggled through the body — repairing a sibling means opening the
  // sibling's own page, where its diff is the one on screen.
  const rows = current.diff.renamed.filter((r) => r.isSelf && wanted.has(r.jobAssetId));
  if (rows.length === 0) {
    throw new ReconcileApplyError(
      409,
      "None of those outputs are currently waiting under an old name — re-check before repairing (they may already have been repaired).",
    );
  }

  // ---- 1. Restamp. The push reads JobAsset.fileName, so this is what makes it
  // upload under the new name rather than re-writing the old one.
  for (const r of rows) {
    await db.jobAsset
      .update({ where: { id: r.jobAssetId }, data: { fileName: r.currentStoredFileName } })
      .catch((err) => {
        console.warn(`[folder-reconcile] restamp failed for ${r.jobAssetId}:`, err);
      });
  }

  // ---- 2. Push the approved bytes under the new names. Throws on a folder or
  // permission problem, which leaves the stale files untouched — correct, since
  // nothing new has landed to replace them.
  let push;
  try {
    push = await pushApprovedAssetsToSupplier({
      styleId: input.styleId,
      assetIds: rows.map((r) => r.jobAssetId),
      userId: input.userId,
    });
  } catch (err) {
    const { SupplierPushError } = await import("./push-to-supplier");
    if (err instanceof SupplierPushError) {
      throw new ReconcileApplyError(err.httpStatus === 403 ? 403 : 409, err.message);
    }
    throw err;
  }
  const pushedByAsset = new Map(push.pushed.map((p) => [p.assetId, p]));

  // ---- 3. Delete the stale copies, but only the ones nothing needs any more.
  //
  // Same-style claimants are handled here rather than in the diff: two documents
  // of THIS style on one collided name share a stale file, and it may only go
  // once both have been re-pushed — i.e. only when both are in this batch.
  const repairedAssets = new Set(rows.map((r) => r.jobAssetId));
  const staleSharedWithin = new Map<string, string[]>();
  for (const r of current.diff.renamed) {
    if (!r.isSelf) continue;
    const arr = staleSharedWithin.get(r.staleItemId) ?? [];
    arr.push(r.jobAssetId);
    staleSharedWithin.set(r.staleItemId, arr);
  }

  const items: RepushOutcome[] = [];
  const deletedItems = new Set<string>();

  for (const r of rows) {
    const pushedFile = pushedByAsset.get(r.jobAssetId);
    const outcome: RepushOutcome = {
      jobAssetId: r.jobAssetId,
      variantKey: r.variantKey,
      name: r.name,
      fromFileName: r.previousFileName,
      toFileName: r.fileName,
      pushed: pushedFile != null,
      webUrl: pushedFile?.webUrl ?? null,
      staleDeleted: false,
      staleLeftBecause: null,
    };

    // Never delete on the strength of a push that didn't happen — that would be
    // removing the supplier's only copy of the artwork.
    if (!pushedFile) {
      outcome.staleLeftBecause = "the re-upload didn't report this file — nothing was deleted";
      items.push(outcome);
      continue;
    }

    // Update the slot's queue row so the next verify agrees with the folder
    // rather than re-arming against a name that no longer exists.
    if (r.queueItemId) {
      await db.supplierSendQueueItem
        .update({
          where: { id: r.queueItemId },
          data: {
            sharePointStatus: "UPLOADED",
            sharePointUrl: pushedFile.webUrl ?? undefined,
            sharePointVerifiedAt: null,
          },
        })
        .catch(() => {});
    }

    if (deletedItems.has(r.staleItemId)) {
      outcome.staleDeleted = true; // already removed for a sibling document in this batch
      items.push(outcome);
      continue;
    }

    if (r.staleClaimedBy.length > 0) {
      const who = r.staleClaimedBy.map((s) => `“${s.styleName}”`).join(", ");
      outcome.staleLeftBecause = `${who} on this PO still relies on “${r.previousFileName}” — repair that style too and the file goes with the last one`;
      items.push(outcome);
      continue;
    }

    const alsoMine = (staleSharedWithin.get(r.staleItemId) ?? []).filter((id) => !repairedAssets.has(id));
    if (alsoMine.length > 0) {
      outcome.staleLeftBecause = `${alsoMine.length} more output(s) on this style still sit under “${r.previousFileName}” — repair them in the same pass`;
      items.push(outcome);
      continue;
    }

    try {
      const del = await deleteDriveItem(target.driveId as string, r.staleItemId);
      outcome.staleDeleted = del.deleted || del.alreadyGone;
      if (del.alreadyGone) outcome.staleLeftBecause = null;
      deletedItems.add(r.staleItemId);
    } catch (err) {
      if (err instanceof SharePointWriteForbiddenError) {
        // The new file IS uploaded; only the cleanup failed. Say exactly that
        // rather than failing the whole repair.
        outcome.staleLeftBecause = "SharePoint refused the delete (403) — the new file is uploaded, the old one is still there";
      } else {
        outcome.staleLeftBecause = `couldn't delete the old file — ${(err as Error).message.slice(0, 80)}`;
      }
    }
    items.push(outcome);
  }

  const staleDeleted = items.filter((i) => i.staleDeleted).length;
  await writeAuditLog(
    input.styleId,
    `folder reconcile: re-pushed ${items.filter((i) => i.pushed).length} renamed output(s) under their current template names` +
      ` · removed ${staleDeleted} stale file(s)` +
      (items.some((i) => i.staleLeftBecause) ? ` · ${items.filter((i) => i.staleLeftBecause).length} old file(s) left in place` : "") +
      (input.userId ? ` · by user ${input.userId}` : ""),
  );

  return {
    repaired: rows.length,
    pushed: items.filter((i) => i.pushed).length,
    staleDeleted,
    staleLeft: items.filter((i) => i.staleLeftBecause != null).length,
    items,
  };
}

// Applying can refuse for reasons that are the USER's to resolve (the folder
// moved, the file already got re-uploaded) rather than bugs — carry an HTTP
// status so the route maps them to 409/403 instead of a blanket 500.
export class ReconcileApplyError extends Error {
  constructor(
    public readonly httpStatus: 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ReconcileApplyError";
  }
}

// Audit trail on the style's newest job, so reconcile actions show up in the
// style's history feed next to the generation/approval/push events — the same
// placement choose-po-folder uses. Best-effort: an audit hiccup must never fail
// an action that already succeeded.
async function writeAuditLog(styleId: string, message: string): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    const job = await db.job.findFirst({
      where: { styleId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await db.log.create({ data: { jobId: job?.id ?? null, level: "INFO", message } });
  } catch {
    /* best-effort */
  }
}

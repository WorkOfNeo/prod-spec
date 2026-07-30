import {
  resolveSupplierFolder,
  findChildFolder,
  listChildFiles,
  listChildFolders,
  resolvePoFolder,
  renameDriveItem,
  sanitizeFileName,
  SharePointWriteForbiddenError,
  type ChildFile,
} from "./supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";
import type { PoFolderMatch } from "./po-folder-matches";

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
  fileName: string; // sanitizeFileName(storedFileName) — the name the push actually writes
  storedFileName: string; // JobAsset.fileName as stored (pre-sanitisation)
  variantKey: string; // the DOCUMENT key ("<base>#<suffix>" for a split output)
  baseKey: string; // the SLOT key a queue row is keyed by
  name: string; // human display name of the output
  docType: string;
  jobAssetId: string;
  queueItemId: string | null; // null ⇒ never queued (the invisible-to-verify case)
  queueStatus: string | null; // SupplierSendQueueItem.sharePointStatus, when queued
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

export type MatchedRow = {
  fileName: string;
  variantKey: string;
  name: string;
  queueItemId: string | null;
  queueStatus: string | null;
  itemId: string;
  webUrl: string | null;
};

export type MissingRow = {
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
  likelyRenamedFrom: (RenameGuess & { variantKey: string; name: string }) | null;
};

export type NotQueuedRow = {
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
  expectedCount: number;
  presentCount: number;
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

// Pure diff of two file lists — no Graph, no DB, no clock. This is the whole
// decision logic of the module and is what the unit tests exercise.
//
// Four buckets, and note that `notQueued` is ORTHOGONAL to the other three:
//   • ok         — expected ∩ present.
//   • missing    — expected ∖ present. The config says this file belongs in the
//                  folder and it is not there.
//   • unexpected — present ∖ expected. NEW SIGNAL: a file nothing in the current
//                  config accounts for. Almost always a hand-rename (paired
//                  with a `missing` below), sometimes a supplier's own upload,
//                  occasionally an output removed from the ProdSpec whose file
//                  was never cleaned up.
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

  const ok: MatchedRow[] = [];
  const missingExpected: ExpectedFile[] = [];
  const matchedKeys = new Set<string>();

  for (const e of input.expected) {
    const k = compareKey(e.fileName);
    const hit = presentByKey.get(k);
    if (hit) {
      matchedKeys.add(k);
      ok.push({
        fileName: e.fileName,
        variantKey: e.variantKey,
        name: e.name,
        queueItemId: e.queueItemId,
        queueStatus: e.queueStatus,
        itemId: hit.itemId,
        webUrl: hit.webUrl,
      });
    } else {
      missingExpected.push(e);
    }
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
      fileName: e.fileName,
      variantKey: e.variantKey,
      baseKey: e.baseKey,
      name: e.name,
      docType: e.docType,
      jobAssetId: e.jobAssetId,
      present: presentByKey.has(compareKey(e.fileName)),
    }));

  return { ok, missing, unexpected, notQueued };
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
export function reconcileStateMessage(state: ReconcileState, ctx?: { supplierName?: string | null; poNumber?: string | null }): string {
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
      return "SharePoint credentials aren't configured in this environment, so the folder can't be listed.";
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

async function sharepointConfigured(): Promise<boolean> {
  const { isSharepointConfigured } = await import("@/lib/publish/publish-approved-job");
  return isSharepointConfigured();
}

type StyleRow = {
  id: string;
  name: string;
  poNumber: string | null;
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
    supplierPoFolderName: style.supplierPoFolderName,
    supplierName: style.supplier?.name ?? null,
    supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
    skipSupplierDelivery: parseCustomerConfig(style.customer.config).skipSupplierDelivery,
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
async function loadExpectedFiles(styleId: string): Promise<ExpectedFile[]> {
  const { db } = await import("@/lib/db");
  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");

  const [outputs, queueRows] = await Promise.all([
    getCurrentOutputsForStyle(styleId),
    db.supplierSendQueueItem.findMany({
      where: { styleId },
      select: { id: true, variantKey: true, sharePointStatus: true },
    }),
  ]);

  const queueByBase = new Map(queueRows.map((r) => [r.variantKey, r]));

  const expected: ExpectedFile[] = [];
  for (const o of outputs) {
    if (o.jobAssetId == null || o.fileName == null) continue;
    if (o.reviewStatus !== "APPROVED" || o.placeholderCount > 0) continue;
    const baseKey = o.variantKey.split("#")[0] || `doc:${o.docType}`;
    const row = queueByBase.get(baseKey);
    expected.push({
      fileName: sanitizeFileName(o.fileName),
      storedFileName: o.fileName,
      variantKey: o.variantKey,
      baseKey,
      name: o.name,
      docType: o.docType,
      jobAssetId: o.jobAssetId,
      queueItemId: row?.id ?? null,
      queueStatus: row?.sharePointStatus ?? null,
    });
  }
  return expected;
}

const EMPTY_DIFF: FolderDiff = { ok: [], missing: [], unexpected: [], notQueued: [] };

// Where a resolution attempt landed, plus the leaf we can list (when we got
// that far). Shared by the read path and by adopt's re-resolution so the two
// can never disagree about which folder they are acting on.
type FolderTarget = {
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
async function resolveApprovedLayoutsFolder(style: StyleRow): Promise<FolderTarget> {
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

  const shell = (state: ReconcileState, extra?: Partial<FolderReconcile>): FolderReconcile => ({
    styleId,
    styleName: style?.name ?? null,
    poNumber: style?.poNumber ?? null,
    supplierName: style?.supplierName ?? null,
    state,
    message: reconcileStateMessage(state, { supplierName: style?.supplierName, poNumber: style?.poNumber }),
    supplierFolderUrl: null,
    poFolderName: null,
    poFolderUrl: null,
    folderUrl: null,
    folderPath: null,
    ambiguousMatches: [],
    expectedCount: 0,
    presentCount: 0,
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
  let expected: ExpectedFile[];
  try {
    expected = await loadExpectedFiles(styleId);
  } catch (err) {
    // Can't say what SHOULD be there ⇒ can't say anything is missing.
    console.warn(`[folder-reconcile] expected-set resolution failed for style ${styleId}:`, err);
    return { result: shell("unavailable", located), target, style: resolved };
  }

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
      expectedCount: expected.length,
      presentCount: present.length,
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
  const missing = current.diff.missing.find(
    (m) => sanitizeFileName(m.fileName).toLowerCase() === sanitizeFileName(input.toFileName).toLowerCase(),
  );
  if (!missing) {
    throw new ReconcileApplyError(
      409,
      "That target name is not currently an expected-but-missing output for this style — re-check before adopting.",
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

// =====================================================
// What did WE put in the suppliers' folders, and is any of it wrong?
//
// READ-ONLY. This script lists and judges; it never renames, never deletes and
// never writes to SharePoint or the database. Repairs go through the per-PO
// page, which re-reads the live folder first — a finding from a scan is stale
// the moment it is printed, and acting on a stale finding is how the wrong file
// gets removed.
//
// RECORD-FIRST, not folder-first. It starts from SupplierSendQueueItem — the
// rows this app wrote when it uploaded — so a file we did not push is never
// examined and never actionable. A clean result therefore means "nothing WE put
// in this folder is wrong", NOT "this folder is clean".
//
//   npm run pushed-files-report                    # every folder we have pushed into
//   npm run pushed-files-report -- --limit=20      # the first 20 folders
//   npm run pushed-files-report -- --below-cutoff  # only orders under the send cutoff
//   npm run pushed-files-report -- --inventory     # counts only, no SharePoint calls
//   npm run pushed-files-report -- --json
// =====================================================
import { loadPushedInventory, scanPushedFolder, poSeqOf } from "@/lib/pushed-files/scan";
import { PUSHED_FILE_KINDS, type PushedFileKind } from "@/lib/pushed-files/verdicts";
import { getSupplierSendMinPo } from "@/lib/settings/app-settings";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const asJson = flag("json");
  const limit = Number(arg("limit") ?? "0") || 0;
  const belowOnly = flag("below-cutoff");

  const minPo = await getSupplierSendMinPo().catch(() => null);
  const inv = await loadPushedInventory();

  let folders = inv.folders;
  if (belowOnly && minPo !== null) {
    folders = folders.filter((f) => {
      const seq = poSeqOf(f.poNumber);
      return seq !== null && seq < minPo;
    });
  }
  folders.sort((a, b) => (poSeqOf(a.poNumber) ?? 0) - (poSeqOf(b.poNumber) ?? 0));

  const totalRecords = [...inv.recordsByFolder.values()].reduce((n, l) => n + l.length, 0);

  if (!asJson) {
    console.log("");
    console.log("Files this app pushed into suppliers' folders");
    console.log("=============================================");
    console.log(`supplier-send cutoff : ${minPo ?? "(none set)"}`);
    console.log(`upload records       : ${totalRecords}`);
    console.log(`folders we pushed to : ${inv.folders.length}`);
    if (belowOnly) console.log(`below the cutoff     : ${folders.length} folders`);
    if (inv.skipped.length) console.log(`unusable records     : ${inv.skipped.length} (see --json)`);
    console.log("");
  }

  if (flag("inventory")) {
    if (asJson) console.log(JSON.stringify({ minPo, totalRecords, folders: inv.folders, skipped: inv.skipped }, null, 2));
    return;
  }

  const scope = limit > 0 ? folders.slice(0, limit) : folders;
  // Once for the whole run: every folder resolves names against the same
  // catalogue, and refreshing it per folder would be the run's biggest cost.
  await ensureLayoutVariantsLoaded(true);

  const totals: Partial<Record<PushedFileKind, number>> = {};
  let unreadable = 0;
  let examined = 0;
  const out: unknown[] = [];

  for (const [i, f] of scope.entries()) {
    const key = `${f.supplierId}::${f.poNumber}`;
    const records = inv.recordsByFolder.get(key) ?? [];
    const res = await scanPushedFolder(f, records, { minPo, variantsAlreadyFresh: true });

    if (res.state !== "ok") {
      unreadable++;
      if (!asJson) console.log(`[${i + 1}/${scope.length}] ${f.poNumber} — UNREADABLE: ${res.stateNote ?? "?"}`);
      out.push({ po: f.poNumber, state: res.state, note: res.stateNote });
      continue;
    }

    examined += res.section?.records ?? 0;
    for (const [k, v] of Object.entries(res.histogram)) {
      totals[k as PushedFileKind] = (totals[k as PushedFileKind] ?? 0) + v.files;
    }

    const flagged = res.section?.flagged ?? [];
    if (!asJson) {
      const bits = Object.entries(res.histogram)
        .map(([k, v]) => `${k}=${v.files}`)
        .join(" ");
      console.log(`[${i + 1}/${scope.length}] ${f.poNumber} — ${res.section?.records ?? 0} of ours · ${bits || "nothing"}`);
      for (const row of flagged) {
        console.log(`      ${row.kind.padEnd(21)} ${row.fileName}`);
        console.log(`      ${" ".repeat(21)} ${row.verdict}`);
      }
    }
    out.push({
      po: f.poNumber,
      records: res.section?.records ?? 0,
      histogram: res.histogram,
      flagged: flagged.map((r) => ({ kind: r.kind, fileName: r.fileName, verdict: r.verdict, proposed: r.proposed })),
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ minPo, totalRecords, scanned: scope.length, unreadable, totals, folders: out }, null, 2));
    return;
  }

  console.log("");
  console.log("Totals");
  console.log("------");
  console.log(`folders scanned   : ${scope.length}${unreadable ? ` (${unreadable} unreadable)` : ""}`);
  console.log(`our files examined: ${examined}`);
  for (const [k, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    const meta = PUSHED_FILE_KINDS[k as PushedFileKind];
    console.log(`  ${String(n).padStart(5)}  ${k.padEnd(22)} ${meta.flagged ? "FLAGGED" : "reported"}  ${meta.title}`);
  }
  console.log("");
  console.log("Nothing outside our own upload records was looked at, so a clean");
  console.log("result means nothing WE put in these folders is wrong — not that");
  console.log("the folders are clean.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .then(async () => {
    const { db } = await import("@/lib/db");
    await db.$disconnect();
  });

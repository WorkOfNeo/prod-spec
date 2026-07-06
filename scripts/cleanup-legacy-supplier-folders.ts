import { cleanupLegacySupplierFolders } from "@/lib/publish/cleanup-legacy-supplier-folders";

// =====================================================
// Delete the WRONG supplier folders from the two earlier naming schemes, now
// that the live layout is "<PO> - <customer> - <supplier>/APPROVED LAYOUTS/":
//   • "<style> – <customer>"                              (pre-rename push)
//   • "<PO> - <customer> - <supplier> - APPROVED LAYOUTS" (first rename, flat)
//
//   npm run cleanup-legacy-supplier-folders            # DRY RUN — lists what it
//                                                      # WOULD delete, deletes nothing
//   npm run cleanup-legacy-supplier-folders -- --apply # delete for real
//
// SAFE ORDER: run `npm run backfill-supplier-folders -- --apply` FIRST (it moves
// the PDFs into the correct APPROVED LAYOUTS subfolder). This script only deletes
// a wrong folder once that correct subfolder exists AND has files — otherwise it
// reports SKIPPED and deletes nothing. Idempotent; needs SharePoint WRITE on
// Contrast-Suppliers. The final list below is what was ACTUALLY deleted.
// =====================================================

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(
    APPLY
      ? "Deleting legacy supplier folders (APPLY — writing to SharePoint)…\n"
      : "Scanning legacy supplier folders (DRY RUN — nothing deleted)…\n",
  );

  const res = await cleanupLegacySupplierFolders({ dryRun: !APPLY });

  for (const it of res.items) {
    const tag =
      it.outcome === "DELETED"
        ? "✓ deleted   "
        : it.outcome === "WOULD_DELETE"
          ? "· would del "
          : it.outcome === "SKIPPED"
            ? "– skipped   "
            : "✗ FAILED    ";
    const kind = it.kind === "legacy-style-customer" ? "[old style–customer]" : "[flat APPROVED LAYOUTS]";
    console.log(`${tag} ${kind.padEnd(24)} ${it.folderName}${it.note ? `  (${it.note})` : ""}`);
  }

  console.log(
    `\n${APPLY ? "Done" : "Dry run"} — scanned ${res.stylesScanned} style(s); found ${res.found} wrong folder(s): ` +
      `${APPLY ? `${res.deleted} deleted` : `${res.wouldDelete} would delete`}, ${res.skipped} skipped` +
      (res.failed > 0 ? `, ${res.failed} failed` : "") +
      ".",
  );

  if (res.skipped > 0) {
    console.log(
      "\nSKIPPED = the correct APPROVED LAYOUTS folder isn't in place yet. Run\n" +
        "  npm run backfill-supplier-folders -- --apply\n" +
        "first, then re-run this.",
    );
  }
  if (res.writeForbidden) {
    console.log("\n⚠ Hit a 403 — SharePoint write on Contrast-Suppliers isn't granted. Ask FLC, then retry.");
  }
  if (!APPLY && res.wouldDelete > 0) {
    console.log("\nRe-run with --apply to delete for real.");
  }

  if (APPLY) {
    const deleted = res.items.filter((i) => i.outcome === "DELETED");
    console.log(`\nDELETED (${deleted.length}):`);
    if (deleted.length === 0) console.log("  (none)");
    for (const d of deleted) {
      console.log(`  ${d.folderName}${d.webUrl ? `  ${d.webUrl}` : ""}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

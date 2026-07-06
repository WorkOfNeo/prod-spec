import { backfillSupplierFolders } from "@/lib/publish/backfill-supplier-folders";

// =====================================================
// One-off backfill: re-push already-delivered styles into the NEW supplier-
// folder naming ("<PO> - <customer> - <supplier> - APPROVED LAYOUTS"). The
// folder-name change is forward-only, so a style whose approved layouts already
// sit in an old "<style> – <customer>" folder would otherwise have its future
// approvals split into the new folder. This consolidates each already-pushed
// style (Style.supplierFolderUrl set) into the new-named folder.
//
//   npm run backfill-supplier-folders            # DRY RUN — resolves scope +
//                                                # SharePoint targets, writes nothing
//   npm run backfill-supplier-folders -- --apply # push for real
//
// Needs SharePoint WRITE on Contrast-Suppliers (Sites.ReadWrite.All / a write
// grant). Same env the app uses (.env). Idempotent — re-running is safe (uploads
// PUT-overwrite by filename, the subfolder is get-or-create). Old folders are
// NOT deleted; the run prints their URLs so you can remove them by hand.
// =====================================================

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(
    APPLY
      ? "Backfilling supplier folders → NEW naming (APPLY — writing to SharePoint)…\n"
      : "Backfilling supplier folders → NEW naming (DRY RUN — nothing written)…\n",
  );

  const result = await backfillSupplierFolders({ dryRun: !APPLY });

  for (const r of result.results) {
    const tag =
      r.status === "REPUSHED" ? (APPLY ? "✓ pushed " : "· would push") : r.status === "FAILED" ? "✗ FAILED " : "– skipped";
    console.log(`${tag}  ${r.styleName.padEnd(16)} ${(r.poNumber ?? "—").padEnd(12)} ${r.note}`);
  }

  console.log(
    `\n${APPLY ? "Done" : "Dry run"} — ${result.repushed}/${result.candidates} already-pushed style(s) ` +
      `${APPLY ? "re-pushed" : "would be re-pushed"} · ${result.skipped} skipped · ${result.failed} failed.`,
  );

  if (APPLY && result.cleanup.length > 0) {
    console.log(`\nOld folders to DELETE MANUALLY (${result.cleanup.length}) — files now live in the new folders:`);
    for (const c of result.cleanup) {
      console.log(`  ${c.styleName.padEnd(16)} ${c.oldFolderUrl}`);
    }
  }

  if (!APPLY && result.repushed > 0) {
    console.log("\nRe-run with --apply to push for real.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

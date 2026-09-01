import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { coverSlug } from "@/lib/pdf/cover-file-name";
import { missingGraphEnvVars } from "@/lib/sharepoint/auth";
import { listChildFiles, sanitizeFileName } from "@/lib/sharepoint/supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "@/lib/sharepoint/supplier-folder-names";
import {
  loadExpectedFiles,
  resolveApprovedLayoutsFolder,
  precheckReconcileState,
  reconcileStateMessage,
  type FolderTarget,
  type ReconcileState,
  type StyleRow,
} from "@/lib/sharepoint/reconcile-folder";
import { loadPoStyles, type PoStyleRow } from "@/lib/sharepoint/po-delivery-run";
import {
  buildCoverCheck,
  buildFileNameCheck,
  type CheckSection,
  type ExpectedCover,
  type ExpectedDoc,
  type FolderFile,
} from "./po-checks";
import { coverNameBody } from "./file-name-shape";

// =====================================================
// Composition + I/O for the /checks page: resolve the PO folder ONCE, work out
// what the whole purchase order expects to be in it, list what is actually
// there, and hand both to the pure logic in po-checks.ts.
//
// Everything here is READ-ONLY. Acting on a finding lives in apply-actions.ts,
// which re-runs this check before it touches anything — a report is a snapshot,
// and a snapshot is never what a destructive action gets to act on.
//
// FOLDER RESOLUTION IS BORROWED, NOT REBUILT. resolveApprovedLayoutsFolder is
// the same chain the push, the verify sweep, the style panel and the delivery
// ledger use. A second way of deciding which folder is "the" PO folder would
// eventually disagree with the first, and then one surface would be proposing
// deletions in a folder the other had never looked at.
//
// UNRESOLVABLE-FOLDER DISCIPLINE, inherited from po-delivery-run.ts and worth
// more here than anywhere else: a 403, a throttle or an ambiguous PO folder
// must NEVER produce a report. A page that renders "everything in this folder
// is unrecognised — delete?" during a Graph blip is actively dangerous, so a
// non-listable state returns the state and NO sections at all.
//
// WHY THE COVER EXPECTATION IS COMPUTED HERE AND NOT TAKEN FROM loadExpectedFiles.
// That function filters on reviewStatus === "APPROVED", and the cover ships
// while still PENDING_REVIEW by design (enqueueCoverForSupplier). So on today's
// main the cover is simply absent from the expected set, and a check built on
// it would report every legitimate cover as an unrecognised file. PR #319
// ("Folder audits: the cover page is an expected document") fixes exactly that
// for the delivery ledger; this module deliberately does not wait for it, and
// asks the cover's own naming rule directly instead. When #319 lands, nothing
// here changes — the cover simply also starts appearing in the ledger.
// =====================================================

export type PoChecksStyle = { styleId: string; styleName: string };

export type PoChecksReport = {
  poNumber: string;
  supplierId: string;
  supplierName: string | null;
  state: ReconcileState;
  message: string;
  folderUrl: string | null;
  poFolderUrl: string | null;
  folderPath: string | null;
  styles: PoChecksStyle[];
  // Empty whenever the folder could not be listed — see the header. A caller
  // must read `state` before it reads these.
  sections: CheckSection[];
  checkedAt: string;
};

// Which suppliers a PO number belongs to. A PO can in principle appear under
// two suppliers (two orders sharing a reference) and each has its OWN folder,
// so the page asks rather than guessing — same rule as /delivery/[po].
export async function resolvePoSuppliers(
  poNumber: string,
): Promise<Array<{ supplierId: string; supplierName: string | null }>> {
  const { db } = await import("@/lib/db");
  const rows = await db.style.findMany({
    where: { poNumber, supplierId: { not: null }, archivedAt: null, deletedAt: null },
    select: { supplierId: true, supplier: { select: { name: true } } },
    distinct: ["supplierId"],
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({ supplierId: r.supplierId as string, supplierName: r.supplier?.name ?? null }));
}

// Which style's folder pin wins when the PO's styles disagree — the same rule
// po-delivery-run.ts uses, so both surfaces land in the same folder.
function representativeStyle(styles: PoStyleRow[]): PoStyleRow | null {
  if (styles.length === 0) return null;
  return styles.find((s) => s.supplierPoFolderName?.trim()) ?? styles[0];
}

// The cover each style on the PO expects TODAY, resolved through the same
// resolver the rename machinery uses. A style with no generated cover simply
// has no expectation: "this style never produced a cover" is a generation
// question, not a question about a file sitting in a folder.
async function loadExpectedCovers(styles: PoStyleRow[]): Promise<ExpectedCover[]> {
  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
  const { resolveCurrentFileNames } = await import("@/lib/sharepoint/current-file-names");

  const out: ExpectedCover[] = [];
  for (const s of styles) {
    let covers: Array<{ jobAssetId: string; variantKey: string; stored: string }>;
    try {
      const outputs = await getCurrentOutputsForStyle(s.id);
      covers = outputs
        .filter(
          (o) =>
            o.variantKey.split("#")[0] === COVER_VARIANT_KEY && o.jobAssetId != null && o.fileName != null,
        )
        .map((o) => ({ jobAssetId: o.jobAssetId as string, variantKey: o.variantKey, stored: o.fileName as string }));
    } catch (err) {
      // One unreadable style must not sink the PO's report — but it WOULD
      // understate the expectation, and an understated expectation is how a
      // legitimate cover gets proposed for deletion. Logged, never swallowed.
      console.warn(`[checks] cover expectation failed for style ${s.id} on ${s.poNumber}:`, err);
      continue;
    }
    if (covers.length === 0) continue;

    let resolved: Awaited<ReturnType<typeof resolveCurrentFileNames>> = new Map();
    try {
      resolved = await resolveCurrentFileNames(
        s.id,
        covers.map((c) => ({ jobAssetId: c.jobAssetId, variantKey: c.variantKey })),
        { variantsAlreadyFresh: true },
      );
    } catch (err) {
      console.warn(`[checks] cover name resolution failed for style ${s.id}:`, err);
    }

    for (const c of covers) {
      const r = resolved.get(c.jobAssetId);
      // No current answer ⇒ keep asking about the stamped name. Never invent
      // one — that is current-file-names.ts' rule and it holds here too.
      const currentName = sanitizeFileName(r?.kind === "resolved" ? r.fileName : c.stored);
      const storedSanitised = sanitizeFileName(c.stored);
      out.push({
        styleId: s.id,
        styleName: s.name,
        styleSlugs: coverSlugsFor(s.name, currentName, storedSanitised),
        currentName,
        previousName: storedSanitised.toLowerCase() === currentName.toLowerCase() ? null : storedSanitised,
      });
    }
  }
  return out;
}

// Every spelling of a style that could open a cover name. Style.name is the
// Monday row name and is what `styleNumber` maps to in the ordinary case, but
// it is a RENDER field and a customer's mapping could point it elsewhere — so
// the first segment of each name the resolver actually produced is contributed
// too. An extra entry only ever costs us a flagged row falling from "delete
// this, it isn't on the PO" to "check this, it might be" — the safe direction.
function coverSlugsFor(styleName: string, ...coverNames: string[]): string[] {
  const slugs = new Set<string>([coverSlug(styleName)]);
  for (const n of coverNames) {
    const body = coverNameBody(n);
    if (body) slugs.add(body.split("-")[0]);
  }
  return [...slugs].filter(Boolean);
}

// The files actually in the folder. The APPROVED LAYOUTS leaf is the folder the
// app writes into; the PO folder above it is listed too so a file dropped one
// level up is VISIBLE — it is never actionable (see the location gate).
async function listFolderFiles(target: FolderTarget): Promise<FolderFile[] | null> {
  const driveId = target.driveId;
  if (!driveId) return [];
  const files: FolderFile[] = [];

  if (target.leafItemId) {
    try {
      for (const f of await listChildFiles(driveId, target.leafItemId)) {
        files.push({
          fileName: f.name,
          itemId: f.id,
          webUrl: f.webUrl,
          size: f.size,
          lastModifiedAt: f.lastModifiedAt,
          location: "approved-layouts",
        });
      }
    } catch {
      // The leaf is the folder the report is ABOUT. Failing to list it is not a
      // finding, it is an absence of evidence — the caller turns this into
      // "unavailable" and shows no sections.
      return null;
    }
  }

  if (target.poFolderItemId) {
    try {
      for (const f of await listChildFiles(driveId, target.poFolderItemId)) {
        files.push({
          fileName: f.name,
          itemId: f.id,
          webUrl: f.webUrl,
          size: f.size,
          lastModifiedAt: f.lastModifiedAt,
          location: "po-folder",
        });
      }
    } catch (err) {
      // The parent is a bonus. Losing it costs visibility of a misplaced file,
      // never correctness of the folder we actually audit — so it does not sink
      // the report the way the leaf does.
      console.warn(`[checks] could not list the PO folder above APPROVED LAYOUTS:`, err);
    }
  }

  return files;
}

// The report, PLUS the folder resolution it was computed against.
// apply-actions.ts needs both — the report to validate what it was asked to do,
// and the (driveId, folder) it was computed against to do it. Re-resolving the
// folder for the write would open a window in which a deletion lands in a
// folder the check never looked at, which is precisely the accident the whole
// re-check discipline exists to prevent.
export async function runPoChecksResolved(input: {
  supplierId: string;
  poNumber: string;
}): Promise<{ report: PoChecksReport; target: FolderTarget | null }> {
  const styles = await loadPoStyles(input.supplierId, input.poNumber);
  const rep = representativeStyle(styles);

  const shell = (state: ReconcileState, extra?: Partial<PoChecksReport>): PoChecksReport => ({
    poNumber: input.poNumber,
    supplierId: input.supplierId,
    supplierName: rep?.supplierName ?? null,
    state,
    message: reconcileStateMessage(state, {
      supplierName: rep?.supplierName,
      poNumber: input.poNumber,
      missingEnvVars: missingGraphEnvVars(),
    }),
    folderUrl: null,
    poFolderUrl: null,
    folderPath: null,
    styles: styles.map((s) => ({ styleId: s.id, styleName: s.name })),
    sections: [],
    checkedAt: new Date().toISOString(),
    ...extra,
  });

  if (!rep) return { report: shell("style-not-found"), target: null };

  const { isGraphConfigured } = await import("@/lib/sharepoint/auth");
  const blocked = precheckReconcileState({
    styleFound: true,
    hasSupplier: rep.supplierName != null,
    supplierFolderUrl: rep.supplierFolderUrl,
    poNumber: rep.poNumber,
    // A PO is skipped only when EVERY style on it is a self-delivering
    // customer — one style that does ship means the folder is real.
    skipSupplierDelivery: styles.every((s) => s.skipSupplierDelivery),
    sharepointConfigured: isGraphConfigured(),
  });
  if (blocked) return { report: shell(blocked), target: null };

  const target = await resolveApprovedLayoutsFolder(rep as StyleRow);
  const located = {
    folderUrl: target.folderUrl,
    poFolderUrl: target.poFolderUrl,
    folderPath: target.poFolderName ? `${target.poFolderName} / ${APPROVED_LAYOUTS_SUBFOLDER}` : null,
  };
  if (target.state !== "ok" && target.state !== "subfolder-missing") {
    return { report: shell(target.state, located), target };
  }

  // The layout-variant force-refresh re-reads every published layout, so it
  // happens ONCE here and every per-style resolution is told it is fresh.
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  await ensureLayoutVariantsLoaded(true);

  const expectedDocs: ExpectedDoc[] = [];
  for (const s of styles) {
    try {
      expectedDocs.push(...(await loadExpectedFiles({ id: s.id, name: s.name }, true, true)));
    } catch (err) {
      console.warn(`[checks] expected-set failed for style ${s.id} on ${input.poNumber}:`, err);
    }
  }
  const expectedCovers = await loadExpectedCovers(styles);

  const present = await listFolderFiles(target);
  if (present === null) return { report: shell("unavailable", located), target };

  return {
    report: shell(target.state, {
      ...located,
      sections: [
        buildCoverCheck({ expected: expectedCovers, present }),
        buildFileNameCheck({ expected: expectedDocs, present }),
      ],
    }),
    target,
  };
}

// READ-ONLY. The report on its own — what every caller that only wants to LOOK
// at a PO folder should use.
export async function runPoChecks(input: { supplierId: string; poNumber: string }): Promise<PoChecksReport> {
  return (await runPoChecksResolved(input)).report;
}

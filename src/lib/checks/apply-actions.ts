import { deleteDriveItem, renameDriveItem, SharePointWriteForbiddenError } from "@/lib/sharepoint/supplier-folder";
import { runPoChecksResolved, type PoChecksReport } from "./run-po-checks";
import type { CheckAction, CheckId, CheckRow } from "./po-checks";

// =====================================================
// The ONLY thing in the checks feature that writes. Everything else looks.
//
// This is the first surface in the app that deletes from a supplier's
// SharePoint folder, and a deletion there has no undo we control — the file
// leaves a folder somebody is printing from. The rules below are therefore
// structural, not advisory:
//
//  1. NOTHING IS ACTED ON FROM THE REPORT THE USER WAS SHOWN. Every apply
//     re-runs the check against the live folder first and validates each
//     request against THAT. A report is a snapshot; between the scan and the
//     click an output can be re-run, a template can be fixed and a colleague
//     can rename something. Acting on the stale picture is how the wrong file
//     goes.
//  2. ONLY FLAGGED ROWS. A row the fresh check puts in the "looks right" group
//     is not actionable at any price. There is no "force" parameter and no
//     endpoint that takes a bare item id.
//  3. ONLY THE ACTION THE ROW ALLOWS. `allowed` is computed by the pure check;
//     a request for anything else is REFUSED and recorded as refused. A rename
//     must also name exactly the target the check proposed — the client does
//     not get to choose a new name.
//  4. FILES ONLY, NEVER A FOLDER. Every actionable id comes from listChildFiles,
//     which returns only items Graph marked as files, and the id is re-derived
//     from the fresh listing on every apply.
//  5. NEVER OUTSIDE APPROVED LAYOUTS. Enforced in the pure check (rows outside
//     it have an empty `allowed`) and asserted again here, because this is the
//     one place where being wrong is irreversible.
//  6. NO AUTOMATIC ANYTHING. There is no sweep, no cron and no "repair all"
//     that reaches this module. A person picks the rows and confirms them by
//     name, every time.
//  7. EVERY ATTEMPT IS LOGGED, including the refusals and the failures, with
//     the verdict the person was shown. See the FolderCheckAction model.
// =====================================================

export type RequestedAction = {
  checkId: CheckId;
  // The Graph item id. Names are not identity — see rule 1.
  itemId: string;
  // The name the client believed it was acting on. Re-checked against the live
  // listing so a file renamed since the scan is refused rather than acted on.
  fileName: string;
  action: CheckAction;
  // Required for a rename, and must equal the target the check proposes.
  newName?: string;
};

export type ActionOutcome = "done" | "already-gone" | "conflict" | "refused" | "failed";

export type AppliedAction = {
  checkId: CheckId;
  itemId: string;
  fileName: string;
  action: CheckAction;
  newName: string | null;
  outcome: ActionOutcome;
  message: string;
};

export type ApplyResult = {
  poNumber: string;
  applied: AppliedAction[];
  done: number;
  refused: number;
  failed: number;
  // The folder as it stands AFTER the writes — so the page never shows a
  // picture that predates its own actions.
  report: PoChecksReport;
};

// A hard ceiling on one request. Not a performance limit — a blast-radius one.
// A folder holding more than this many flagged files is a situation for a
// person to look at, not for one button press to resolve.
export const MAX_ACTIONS_PER_REQUEST = 100;

export class ApplyChecksError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ApplyChecksError";
  }
}

type ActionableRow = { row: CheckRow; checkId: CheckId };

export async function applyCheckActions(input: {
  supplierId: string;
  poNumber: string;
  actions: RequestedAction[];
  userId?: string;
  userEmail?: string;
}): Promise<ApplyResult> {
  if (input.actions.length === 0) {
    throw new ApplyChecksError(400, "No files were selected.");
  }
  if (input.actions.length > MAX_ACTIONS_PER_REQUEST) {
    throw new ApplyChecksError(
      400,
      `That is ${input.actions.length} files in one go; this page will do at most ${MAX_ACTIONS_PER_REQUEST}. Work through them in batches so each confirmation stays readable.`,
    );
  }

  // Rule 1: the live folder, re-checked now.
  const { report, target } = await runPoChecksResolved({
    supplierId: input.supplierId,
    poNumber: input.poNumber,
  });
  if (report.state !== "ok") {
    // "subfolder-missing" lands here too, and correctly: there is no folder to
    // act in. Anything else is a resolution failure, and a resolution failure
    // is never a licence to delete.
    throw new ApplyChecksError(409, report.message);
  }
  const driveId = target?.driveId;
  if (!driveId) throw new ApplyChecksError(409, report.message);

  // Rule 2 + 3: the index of what is actionable is built from the FLAGGED rows
  // of the fresh report only.
  const actionable = new Map<string, ActionableRow>();
  for (const section of report.sections) {
    for (const row of section.flagged) {
      actionable.set(`${section.id}:${row.id}`, { row, checkId: section.id });
    }
  }

  const applied: AppliedAction[] = [];
  const audit: Array<Parameters<typeof recordActions>[0][number]> = [];

  for (const req of input.actions) {
    const hit = actionable.get(`${req.checkId}:${req.itemId}`);
    const push = (outcome: ActionOutcome, message: string, newName: string | null = req.newName ?? null) => {
      applied.push({
        checkId: req.checkId,
        itemId: req.itemId,
        fileName: hit?.row.fileName ?? req.fileName,
        action: req.action,
        newName,
        outcome,
        message,
      });
      audit.push({
        poNumber: input.poNumber,
        supplierId: input.supplierId,
        checkId: req.checkId,
        action: req.action,
        fileName: hit?.row.fileName ?? req.fileName,
        newFileName: newName,
        driveId,
        driveItemId: req.itemId,
        folderUrl: hit?.row.location === "po-folder" ? report.poFolderUrl : report.folderUrl,
        location: hit?.row.location ?? "unknown",
        verdict: hit?.row.verdict ?? null,
        outcome,
        error: outcome === "failed" || outcome === "refused" ? message : null,
        userId: input.userId ?? null,
        userEmail: input.userEmail ?? null,
      });
    };

    if (!hit) {
      push(
        "refused",
        `“${req.fileName}” is no longer flagged by this check — the folder has changed since it was scanned. Nothing was done to it.`,
      );
      continue;
    }
    const { row } = hit;
    if (row.fileName !== req.fileName) {
      push("refused", `“${req.fileName}” is now called “${row.fileName}”. Re-check before acting on it.`);
      continue;
    }
    // Rule 5, asserted a second time. The pure check already leaves `allowed`
    // empty out here, so this can only fire if that ever regresses.
    if (row.location !== "approved-layouts") {
      push("refused", `“${row.fileName}” is not in APPROVED LAYOUTS. The app does not write outside that folder.`);
      continue;
    }
    if (!row.allowed.includes(req.action)) {
      push("refused", `This check does not offer “${req.action}” for “${row.fileName}”.`);
      continue;
    }
    if (req.action === "rename") {
      if (!row.renameTo || req.newName !== row.renameTo) {
        // Rule 3: the client proposes nothing. The only legal target is the one
        // resolved from the layout's current template.
        push(
          "refused",
          `The only name “${row.fileName}” may be renamed to is “${row.renameTo ?? "—"}”, resolved from the layout's current file name.`,
          row.renameTo,
        );
        continue;
      }
    }

    try {
      if (req.action === "delete") {
        const res = await deleteDriveItem(driveId, row.id);
        push(
          res.deleted ? "done" : "already-gone",
          res.deleted ? `Removed “${row.fileName}”.` : `“${row.fileName}” was already gone.`,
          null,
        );
      } else {
        const res = await renameDriveItem(driveId, row.id, row.renameTo as string);
        if (res.renamed) push("done", `Renamed “${row.fileName}” to “${row.renameTo}”.`, row.renameTo);
        else if (res.notFound) push("already-gone", `“${row.fileName}” was already gone.`, row.renameTo);
        else if (res.conflict) {
          push(
            "conflict",
            `A file called “${row.renameTo}” already exists in the folder, so “${row.fileName}” was left alone. Re-check — it is probably a stale copy to remove instead.`,
            row.renameTo,
          );
        } else push("failed", `SharePoint refused the rename of “${row.fileName}”.`, row.renameTo);
      }
    } catch (err) {
      // One file failing must never abandon the rest of the batch, and a 403
      // has to read as a permission gap rather than as a mystery.
      push(
        "failed",
        err instanceof SharePointWriteForbiddenError
          ? `SharePoint refused the change to “${row.fileName}” (403) — the app needs write access to the suppliers site.`
          : `“${row.fileName}” — ${(err as Error).message.slice(0, 160)}`,
      );
    }
  }

  await recordActions(audit);

  return {
    poNumber: input.poNumber,
    applied,
    done: applied.filter((a) => a.outcome === "done").length,
    refused: applied.filter((a) => a.outcome === "refused").length,
    failed: applied.filter((a) => a.outcome === "failed" || a.outcome === "conflict").length,
    // Re-check so the page can never show a picture that predates its own writes.
    report: (await runPoChecksResolved({ supplierId: input.supplierId, poNumber: input.poNumber })).report,
  };
}

type AuditRow = {
  poNumber: string;
  supplierId: string;
  checkId: string;
  action: string;
  fileName: string;
  newFileName: string | null;
  driveId: string;
  driveItemId: string;
  folderUrl: string | null;
  location: string;
  verdict: string | null;
  outcome: string;
  error: string | null;
  userId: string | null;
  userEmail: string | null;
};

// Best-effort by necessity, and loud when it fails. A file that has already
// left SharePoint cannot be un-deleted because the audit insert failed, so
// throwing here would trade a missing log line for an inconsistent folder. The
// console line is the fallback record; the P2021 arm covers the window between
// a deploy and its migration.
async function recordActions(rows: AuditRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { db } = await import("@/lib/db");
    await db.folderCheckAction.createMany({ data: rows });
  } catch (err) {
    const code = !!err && typeof err === "object" ? (err as { code?: string }).code : undefined;
    console.error(
      code === "P2021"
        ? "[checks] folder_check_actions does not exist yet — the audit rows below were NOT persisted:"
        : "[checks] could not write the folder-check audit rows:",
      JSON.stringify(rows),
      err,
    );
  }
}

// The audit trail for one PO, newest first. P2021-hardened for the same reason
// the delivery list is: Railway runs `prisma migrate deploy` before `npm start`,
// so a missing table should be impossible — but a migration that failed while
// the container still served would otherwise turn the page into a 500, and an
// empty history is the honest answer either way.
export async function loadCheckHistory(poNumber: string, take = 50) {
  const { db } = await import("@/lib/db");
  return db.folderCheckAction
    .findMany({ where: { poNumber }, orderBy: { createdAt: "desc" }, take })
    .catch((err: unknown) => {
      if (!!err && typeof err === "object" && (err as { code?: string }).code === "P2021") return [];
      throw err;
    });
}

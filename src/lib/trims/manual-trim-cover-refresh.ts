import type { CoverRequeueResult } from "@/lib/publish/requeue-cover";

// =====================================================
// Close the loop between "a manual packaging line changed" and "the supplier's
// cover says so".
//
// THE LEAK THIS FIXES. Supplying a manual line — uploading the document, or
// stating by hand that the folder already holds it — flips the row in the
// cover's required-packaging manifest. But the manifest is only a description
// of what the cover WOULD print; the cover the supplier actually has is a PDF
// rendered at some earlier moment and pushed to their folder. Nothing connected
// the two. The DB said approved, the file in the folder still said "Waiting for
// Customer Information", and it stayed that way until somebody happened to run
// Settings ▸ Cover page ▸ Regenerate — a sweep that has no cron behind it, so
// in practice: never.
//
// Every piece of the repair already existed and is used verbatim here, because
// a second way of rebuilding a cover is a second way for it to drift:
//
//   refreshStyleCoverAsset   rebuild the CURRENT cover asset in place
//   enqueueCoverForSupplier  re-arm that style's supplier-send row
//   pushQueuedSupplierUploads   push it now, honouring every send gate
//
// onlyWhenChanged IS THE WHOLE SAFETY STORY. It compares the manifest this
// cover would print against the fingerprint the cover already carries, and
// rebuilds only on a real difference. So the calls that genuinely move the page
// (a first upload, an approval, a withdrawal, a removal) rebuild and re-push,
// while the ones that don't (replacing a file on a line already delivered) cost
// one manifest build and stop — no puppeteer pass, no overwritten file in a
// supplier's folder, no re-armed digest row. That is what makes it safe to call
// this after EVERY manual-trim mutation rather than trying to reason about
// which transitions matter at each call site.
//
// TRIGGER IS "content", DELIBERATELY. Per cover-rebuild-trigger.ts that means
// the supplier is told. It is the right answer: a packaging line they were
// asked to wait for is now supplied, which is this order's own facts moving and
// something they act on — not a house-wording sweep. The blast radius is one
// style per click by a person who is looking at that style, which is the
// opposite of the 2026-08-13 mass send that the wording/content split exists to
// prevent.
//
// FAIL-SOFT, ALWAYS. By the time this runs the operator's action has already
// succeeded and is persisted. A cover that won't rebuild must therefore not
// turn a completed upload into an error — it comes back as a described outcome
// the panel can show, never a throw.
// =====================================================

export type ManualTrimCoverOutcome = {
  // What happened to the cover PDF itself.
  cover: "refreshed" | "unchanged" | "no-cover" | "error";
  // Whether the supplier-send row was re-armed, and why not when it wasn't.
  requeue: CoverRequeueResult | "error" | null;
  // Files actually pushed in this call (0 when batch-send is off — the armed
  // row then waits for the switch, which is not a failure).
  pushed: number;
  // One sentence for the reviewer standing in front of the panel. Null when
  // there is nothing worth saying (the cover already said the right thing).
  message: string | null;
};

const UNCHANGED: ManualTrimCoverOutcome = {
  cover: "unchanged",
  requeue: null,
  pushed: 0,
  message: null,
};

// The call the routes make. refreshCoverAfterManualTrimChange already catches
// everything it does, but the routes must not DEPEND on that promise: by the
// time they call it the operator's action is committed, and a throw escaping to
// the caller would report a 500 for work that actually succeeded — the worst
// possible lie to tell someone who just approved something. So the guarantee is
// enforced here as well as promised there.
export async function refreshCoverAfterManualTrimChangeSafe(
  styleId: string,
): Promise<ManualTrimCoverOutcome> {
  try {
    return await refreshCoverAfterManualTrimChange(styleId);
  } catch (err) {
    console.warn(`[manual-trim-cover] refresh threw for ${styleId}:`, err);
    return {
      cover: "error",
      requeue: null,
      pushed: 0,
      message: `Saved, but the cover page couldn't be rebuilt: ${(err as Error).message}`,
    };
  }
}

export async function refreshCoverAfterManualTrimChange(
  styleId: string,
): Promise<ManualTrimCoverOutcome> {
  try {
    // Lazy, exactly as the General-information regenerate route does it: the
    // render chain pulls in puppeteer, and the GET that lists these zones must
    // not cold-start the whole PDF stack to answer a read.
    const { refreshStyleCoverAsset } = await import("@/lib/pdf/refresh-cover");
    const { enqueueCoverForSupplier } = await import("@/lib/publish/requeue-cover");
    const { notifiesSupplier } = await import("@/lib/pdf/cover-rebuild-trigger");

    const refresh = await refreshStyleCoverAsset(styleId, { onlyWhenChanged: true });

    if (refresh.status === "skipped-unchanged") return UNCHANGED;
    if (refresh.status === "no-cover") {
      // Not an error, and the common case for a style that has never generated
      // a bundle: there is no cover to correct, and the first one it renders
      // will carry this line already.
      return {
        cover: "no-cover",
        requeue: null,
        pushed: 0,
        message: "No cover has been generated for this style yet — the first one will include it.",
      };
    }
    if (refresh.status !== "refreshed") {
      return {
        cover: "error",
        requeue: null,
        pushed: 0,
        message: `Saved, but the cover page couldn't be rebuilt: ${
          refresh.status === "error" ? refresh.error : refresh.status
        }`,
      };
    }

    let requeue: CoverRequeueResult | "error";
    try {
      requeue = await enqueueCoverForSupplier(styleId, refresh.coverAssetId, {
        notifySupplier: notifiesSupplier("content"),
      });
    } catch (err) {
      console.warn(`[manual-trim-cover] requeue failed for ${styleId}:`, err);
      requeue = "error";
    }

    if (requeue !== "queued") {
      // The cover IS corrected in the app either way; say plainly why the
      // supplier's folder hasn't had it, rather than leaving a half-success
      // silent. These reasons are the enqueue gates, not faults.
      const why: Record<string, string> = {
        "not-delivered": "this style has no supplier folder to deliver to",
        "no-outputs": "no outputs have been generated for this style yet",
        "below-cutoff": "this PO is below the supplier-send cutoff",
        error: "the supplier queue could not be armed",
      };
      return {
        cover: "refreshed",
        requeue,
        pushed: 0,
        message: `Cover page rebuilt, but not sent — ${why[requeue] ?? requeue}.`,
      };
    }

    // Push now rather than waiting for the recurring sweep: a person is looking
    // at this style and expects the supplier's copy to be right. Scoped to this
    // one style so a failure belongs to it by name.
    try {
      const { pushQueuedSupplierUploads } = await import(
        "@/lib/sharepoint/push-queued-to-supplier"
      );
      const sweep = await pushQueuedSupplierUploads({
        styleIds: [styleId],
        recordRunAs: "manual-trim",
      });
      return {
        cover: "refreshed",
        requeue,
        pushed: sweep.uploaded,
        message:
          sweep.uploaded > 0
            ? "Cover page updated and re-uploaded to the supplier's folder."
            : "Cover page updated. It's queued for the supplier's folder — supplier sending is currently off.",
      };
    } catch (err) {
      console.warn(`[manual-trim-cover] push failed for ${styleId}:`, err);
      return {
        cover: "refreshed",
        requeue,
        pushed: 0,
        message: `Cover page updated, but sending it to the supplier's folder failed: ${
          (err as Error).message
        }`,
      };
    }
  } catch (err) {
    // The action that called this has already been saved. Nothing here may undo
    // that by throwing.
    console.warn(`[manual-trim-cover] refresh failed for ${styleId}:`, err);
    return {
      cover: "error",
      requeue: null,
      pushed: 0,
      message: `Saved, but the cover page couldn't be rebuilt: ${(err as Error).message}`,
    };
  }
}

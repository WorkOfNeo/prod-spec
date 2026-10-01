import type { ReadinessStep } from "@/lib/styles/readiness-notice";
import { belowCutoffNote, isDeliverablePo } from "@/lib/publish/supplier-send-cutoff";

// =====================================================
// Cover status — "why hasn't this style's cover page been generated / uploaded
// to the supplier folder?" as ONE readiness step for the /styles/[id] panel.
//
// The cover is never generated on its own: it is the framing document every
// generation JOB builds (runner.ts). So "no cover" always means "no job has
// run", and the reasons are the auto-generate gates — the same ones, in the
// same order, as maybeEnqueueStyleGeneration (queue/generation-sweep.ts) and
// autoEnqueueReadyOutputs (queue/auto-enqueue.ts). Once a cover exists, the
// reasons it isn't in the supplier folder are enqueueCoverForSupplier's gates
// (publish/requeue-cover.ts), then the push outcome on its send-queue row.
//
// Filling in Monday's "Navision Task" (the PO number) is only the FIRST gate:
// it starts the EAN lookup, but a job (and with it the cover) only runs once at
// least one output has all its required fields. This step exists so the page
// says which gate a style is actually stuck on.
//
// Pure: no DB. The page loads the signals and passes them in. Keep the gate
// order in sync with the three files above.
// =====================================================

export type CoverState =
  // No cover yet.
  | "no-po"
  | "no-prod-spec"
  | "generating"
  | "auto-off"
  | "prod-spec-inactive"
  | "floated"
  | "cover-only-manual"
  | "waiting-on-data"
  | "nothing-to-generate"
  | "below-generation-cutoff"
  | "awaiting-sweep"
  // Cover exists, not sent.
  | "no-supplier"
  | "self-delivering"
  | "below-send-cutoff"
  | "held-no-outputs"
  | "not-queued"
  // Cover exists, queued for SharePoint.
  | "upload-pending"
  | "uploaded"
  | "no-folder"
  | "ambiguous-folder"
  | "upload-failing"
  | "upload-gave-up"
  | "upload-skipped";

export type CoverStatusInput = {
  // hasPoNumber(style.poNumber) — the Monday "Navision Task" cell.
  hasPo: boolean;
  poSeq: number | null;
  autoGenerateEnabled: boolean;
  hasProdSpec: boolean;
  prodSpecActive: boolean;
  coverOnly: boolean;
  // getGenerationMinPo() — gates the background sweep only.
  generationMinPo: number | null;
  // Enabled, non-excluded outputs whose required fields are all filled / not.
  readyOutputs: number;
  waitingOutputs: number;
  inFlightJobs: number;
  failedJobs: number;
  maxGenAttempts: number;
  // Latest cover asset on a non-FAILED job (rebuilt in place → updatedAt).
  cover: { updatedAt: Date } | null;
  // Generated output documents (framing pages excluded), non-FAILED jobs.
  realOutputsGenerated: number;
  hasSupplier: boolean;
  skipSupplierDelivery: boolean;
  // getSupplierSendMinPo().
  supplierSendMinPo: number | null;
  // The style's __cover__ supplier-send queue row, if any.
  queueRow: {
    sharePointStatus: string;
    sharePointError: string | null;
    pushAttempts: number;
    lastPushAt: Date | null;
  } | null;
  maxPushAttempts: number;
};

export type CoverStatus = { state: CoverState; step: ReadinessStep };

function fmt(d: Date): string {
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

function step(
  state: CoverState,
  s: Omit<ReadinessStep, "key"> & { key?: string },
): CoverStatus {
  return { state, step: { key: `cover-${state}`, ...s } };
}

export function coverStatus(i: CoverStatusInput): CoverStatus {
  if (i.cover) return coverDelivery(i, i.cover);

  // --- No cover: which generation gate stopped the job? ---------------------

  // Gates already shown higher up the ladder (PO / prod spec) stay amber/zinc
  // here so they don't take over the headline twice — the cover line just
  // connects them to "and that's why there's no cover".
  if (!i.hasPo) {
    return step("no-po", {
      status: "waiting",
      tone: "amber",
      title: "No cover: needs PO (Navision Task)",
      detail:
        "Nothing generates without a PO number. Fill Monday's \"Navision Task\" cell — the EAN lookup starts, and the cover is built with the first output once its fields are in place.",
      owner: "REVIEWER",
      actions: [{ label: "Open on Monday", key: "openMonday", kind: "default" }],
    });
  }
  if (!i.hasProdSpec) {
    return step("no-prod-spec", {
      status: "idle",
      tone: "zinc",
      title: "No cover: no prod spec",
      detail: "The cover is built by a generation job, and nothing generates without a linked prod spec (see above).",
      owner: "ADMIN",
    });
  }
  if (i.inFlightJobs > 0) {
    return step("generating", {
      status: "running",
      tone: "sky",
      title: "Cover generating",
      detail: "A generation job is running; it builds the cover with the outputs.",
      owner: "SYSTEM",
    });
  }
  if (!i.autoGenerateEnabled) {
    return step("auto-off", {
      status: "blocked",
      tone: "amber",
      title: "No cover: auto-generate is off",
      detail:
        "The global auto-generate switch is off, so nothing generates on its own. Turn it on in Settings, or generate this style manually.",
      owner: "ADMIN",
      actions: [
        { label: "Open Settings", key: "openSettings", kind: "default" },
        { label: "Generate", key: "rerun", kind: "link" },
      ],
    });
  }
  if (!i.prodSpecActive) {
    return step("prod-spec-inactive", {
      status: "blocked",
      tone: "amber",
      title: "No cover: prod spec inactive",
      detail:
        "The linked prod spec is inactive (not yet reviewed), and inactive specs never auto-generate. Activate it, or generate this style manually.",
      owner: "ADMIN",
      actions: [{ label: "Open prod spec", key: "openProdSpec", kind: "default" }],
    });
  }
  if (i.failedJobs >= i.maxGenAttempts) {
    return step("floated", {
      status: "blocked",
      tone: "red",
      title: `No cover: generation failed ${i.failedJobs}×`,
      detail: `Generation failed ${i.failedJobs} times, so auto-generation stopped retrying this style. Check the job log (History tab) and re-run; a successful run clears this.`,
      owner: "ADMIN",
      actions: [{ label: "Re-run", key: "rerun", kind: "default" }],
    });
  }
  if (i.readyOutputs === 0) {
    if (i.coverOnly) {
      return step("cover-only-manual", {
        status: "blocked",
        tone: "amber",
        title: "No cover: cover-only spec needs a manual run",
        detail:
          "This spec produces only the cover, so there's no output whose data \"lands\" to trigger it automatically. Generate it manually.",
        owner: "ADMIN",
        actions: [{ label: "Generate", key: "rerun", kind: "default" }],
      });
    }
    if (i.waitingOutputs > 0) {
      return step("waiting-on-data", {
        status: "waiting",
        tone: "amber",
        title: "No cover: no output ready yet",
        detail:
          "The cover is built together with the outputs, and none of them has all its required fields yet (see the Monday fields above, and the EAN lookup). It generates automatically as soon as the first output is ready.",
        owner: "REVIEWER",
        actions: [{ label: "Open on Monday", key: "openMonday", kind: "default" }],
      });
    }
    return step("nothing-to-generate", {
      status: "idle",
      tone: "zinc",
      title: "No cover: nothing to generate",
      detail: "Every output is excluded or ignored for this style, so no job runs and no cover is built.",
      owner: "SYSTEM",
    });
  }
  // Ready outputs, no job: event-driven paths (Monday edit, EAN resolve) run
  // regardless of the generation cutoff; only the backlog sweep honours it.
  if (i.generationMinPo !== null && i.poSeq !== null && i.poSeq < i.generationMinPo) {
    return step("below-generation-cutoff", {
      status: "waiting",
      tone: "amber",
      title: "No cover: below generation cutoff",
      detail: `Outputs are ready, but PO ${i.poSeq} is below the generation cutoff (PO ≥ ${i.generationMinPo}), so the background sweep skips it. A Monday edit or a manual Generate will run it.`,
      owner: "ADMIN",
      actions: [{ label: "Generate", key: "rerun", kind: "default" }],
    });
  }
  return step("awaiting-sweep", {
    status: "running",
    tone: "sky",
    title: "Cover will generate on the next sweep",
    detail: `${i.readyOutputs === 1 ? "1 output is" : `${i.readyOutputs} outputs are`} ready and no job has run yet. The background sweep picks it up shortly — or generate now.`,
    owner: "SYSTEM",
    actions: [{ label: "Generate", key: "rerun", kind: "link" }],
  });
}

function coverDelivery(i: CoverStatusInput, cover: { updatedAt: Date }): CoverStatus {
  const built = `Cover built ${fmt(cover.updatedAt)}.`;

  // enqueueCoverForSupplier's gates, in its order.
  if (!i.hasSupplier) {
    return step("no-supplier", {
      status: "blocked",
      tone: "amber",
      title: "Cover not sent: no supplier",
      detail: `${built} No supplier is linked to this style, so there's no folder to upload it to. Link a supplier to the style.`,
      owner: "ADMIN",
    });
  }
  if (i.skipSupplierDelivery) {
    return step("self-delivering", {
      status: "idle",
      tone: "zinc",
      title: "Cover not sent: customer self-delivers",
      detail: `${built} This customer delivers its own goods, so nothing is uploaded to a supplier folder — by design.`,
      owner: "SYSTEM",
    });
  }
  if (!isDeliverablePo(i.poSeq, i.supplierSendMinPo)) {
    return step("below-send-cutoff", {
      status: "idle",
      tone: "zinc",
      title: "Cover not sent: below send cutoff",
      detail: `${built} Not uploaded: ${belowCutoffNote(i.poSeq, i.supplierSendMinPo)}.`,
      owner: "SYSTEM",
    });
  }
  if (i.realOutputsGenerated === 0) {
    return step("held-no-outputs", {
      status: "waiting",
      tone: "amber",
      title: "Cover held until an output generates",
      detail: `${built} A cover is never sent on its own — it ships once at least one real output has been generated to go with it.`,
      owner: "SYSTEM",
    });
  }

  const row = i.queueRow;
  if (!row) {
    return step("not-queued", {
      status: "blocked",
      tone: "amber",
      title: "Cover generated, not queued",
      detail: `${built} It passes every send check but was never queued for upload (likely built before a setting changed). Re-run to rebuild and queue it.`,
      owner: "ADMIN",
      actions: [{ label: "Re-run", key: "rerun", kind: "default" }],
    });
  }

  const tried = row.lastPushAt ? ` Last attempt ${fmt(row.lastPushAt)}.` : "";
  const why = row.sharePointError ? ` ${row.sharePointError}.` : "";
  switch (row.sharePointStatus) {
    case "UPLOADED":
      return step("uploaded", {
        status: "ok",
        tone: "green",
        title: "Cover uploaded",
        detail: `${built} Uploaded to the supplier folder${row.lastPushAt ? ` ${fmt(row.lastPushAt)}` : ""}.`,
        owner: "SYSTEM",
        actions: [{ label: "Open folder", key: "openSupplierFolder", kind: "link" }],
      });
    case "NO_FOLDER":
      return step("no-folder", {
        status: "blocked",
        tone: "red",
        title: "Cover not uploaded: no PO folder",
        detail: `${built} No folder for this PO was found in the supplier's SharePoint drive.${tried} Create the PO folder; the next push picks it up.`,
        owner: "ADMIN",
        actions: [{ label: "Open Suppliers drive", key: "openSuppliersDrive", kind: "default" }],
      });
    case "AMBIGUOUS":
      return step("ambiguous-folder", {
        status: "blocked",
        tone: "red",
        title: "Cover not uploaded: several PO folders",
        detail: `${built} More than one folder in the supplier's drive matches this PO — keep exactly one (see the Supplier folder card).${tried}`,
        owner: "ADMIN",
        actions: [{ label: "Open Suppliers drive", key: "openSuppliersDrive", kind: "default" }],
      });
    case "FAILED":
      if (row.pushAttempts >= i.maxPushAttempts) {
        return step("upload-gave-up", {
          status: "blocked",
          tone: "red",
          title: "Cover upload gave up",
          detail: `${built} Upload failed ${row.pushAttempts}× and stopped retrying (the nightly sweep still tries once).${why}${tried}`,
          owner: "ADMIN",
        });
      }
      return step("upload-failing", {
        status: "waiting",
        tone: "amber",
        title: "Cover upload failing",
        detail: `${built} Upload failed (${row.pushAttempts} of ${i.maxPushAttempts} attempts); it retries automatically.${why}${tried}`,
        owner: "SYSTEM",
      });
    case "SKIPPED":
      return step("upload-skipped", {
        status: "blocked",
        tone: "amber",
        title: "Cover upload skipped",
        detail: `${built} The push skipped this file.${why || " No reason was recorded."}${tried}`,
        owner: "ADMIN",
      });
    default:
      return step("upload-pending", {
        status: "running",
        tone: "sky",
        title: "Cover waiting to upload",
        detail: `${built} Queued; the next SharePoint push uploads it to the supplier folder.${tried}`,
        owner: "SYSTEM",
      });
  }
}

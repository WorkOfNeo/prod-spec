// What the Status pill on /styles says. The rule: "Ready for review" must
// mean real generated PDFs exist — never just "completion hit 100%" (the
// stored Style.status said that, and every Monday re-sync resets it anyway,
// see ingest.ts). A run in flight outranks everything; printed outputs put
// the pill in the review flow; only a style with no PDFs at all falls back
// to the field-readiness ladder from computeReadiness().
//
// Kept Prisma-free (latestJobStatus is the JobStatus string) so it stays a
// pure, testable function — same convention as readiness.ts.

import type { Readiness } from "@/lib/styles/readiness";

export type EffectiveStatusKey =
  | "no_spec"
  | "awaiting_data"
  | "partially_ready"
  | "ready_to_generate"
  | "queued"
  | "ready_for_review"
  | "approved"
  | "rejected";

export type EffectiveStatusTone = "zinc" | "amber" | "green" | "blue" | "purple" | "red";

export type EffectiveStatus = {
  key: EffectiveStatusKey;
  // Pill text, e.g. "Partially ready · 1/3".
  label: string;
  tone: EffectiveStatusTone;
  // Tooltip — the readiness title pre-generation, review context after.
  hint: string;
};

export function computeEffectiveStatus(opts: {
  readiness: Readiness;
  // ≥1 JobAsset on a non-FAILED job for this style.
  hasPdfs: boolean;
  // Status of the most recent job (JobStatus), null when the style never ran.
  latestJobStatus: string | null;
  // Per-output generation summary — feeds the "Partially ready · x/y" label.
  outputs: { ready: number; total: number };
}): EffectiveStatus {
  const { readiness, hasPdfs, latestJobStatus, outputs } = opts;

  // 1 · A run in flight always wins — the user is waiting on it.
  if (latestJobStatus === "QUEUED" || latestJobStatus === "RUNNING") {
    return {
      key: "queued",
      label: latestJobStatus === "QUEUED" ? "Queued" : "Generating",
      tone: "blue",
      hint: "A generation run is in flight — PDFs land shortly.",
    };
  }

  // 2 · Printed outputs exist → the review flow owns the pill. Anything
  //     other than approved/rejected (incl. stale states) reads as waiting
  //     for a reviewer.
  if (hasPdfs) {
    if (latestJobStatus === "APPROVED") {
      return {
        key: "approved",
        label: "Approved",
        tone: "green",
        hint: "Latest run approved — outputs are published.",
      };
    }
    if (latestJobStatus === "REJECTED") {
      return {
        key: "rejected",
        label: "Rejected",
        tone: "red",
        hint: "Latest run rejected — fix and re-run to start a new review.",
      };
    }
    return {
      key: "ready_for_review",
      label: "Ready for review",
      tone: "purple",
      hint: "Generated PDFs are waiting for a reviewer.",
    };
  }

  // 3 · Nothing generated yet → the pre-generation ladder. The readiness
  //     titles already explain what's missing, so they become the tooltip.
  const failedNote = latestJobStatus === "FAILED" ? " Last generation run failed." : "";
  if (!readiness.hasProdSpec) {
    return { key: "no_spec", label: "No spec", tone: "zinc", hint: readiness.title + failedNote };
  }
  if (readiness.reason === "partial") {
    return {
      key: "partially_ready",
      label: `Partially ready · ${outputs.ready}/${outputs.total}`,
      tone: "amber",
      hint: readiness.title + failedNote,
    };
  }
  if (readiness.reason === "incomplete" || readiness.reason === "missing_fields") {
    return { key: "awaiting_data", label: "Awaiting data", tone: "amber", hint: readiness.title + failedNote };
  }
  // ready / auto_off / inactive — the fields are all there; the nuance of
  // WHY it hasn't fired yet (auto-gen off, inactive spec) rides in the hint.
  return { key: "ready_to_generate", label: "Ready to generate", tone: "green", hint: readiness.title + failedNote };
}

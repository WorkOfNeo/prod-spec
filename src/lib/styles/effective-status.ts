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
  | "spec_inactive"
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

// Pill classes per tone — shared by the styles list and the style detail
// page so the two renders can never drift apart.
export const EFFECTIVE_STATUS_TONE_CLASSES: Record<EffectiveStatusTone, string> = {
  zinc: "bg-zinc-100 text-zinc-600",
  amber: "bg-amber-100 text-amber-800",
  green: "bg-emerald-100 text-emerald-800",
  blue: "bg-blue-100 text-blue-800",
  purple: "bg-purple-100 text-purple-800",
  red: "bg-red-100 text-red-800",
};

// The Status facet filter on /styles keys on EffectiveStatusKey rather than
// the per-row label: the label carries a "· x/y" suffix and queued/generating
// share the "queued" key, so deriving options from labels would explode into
// dozens of near-duplicates. These give one stable option per key instead.
// Order = the status ladder (pre-generation readiness → in-flight → review
// flow). Keep in sync with EffectiveStatusKey above.
export const STATUS_FACET_KEYS: readonly EffectiveStatusKey[] = [
  "no_spec",
  "awaiting_data",
  "partially_ready",
  "spec_inactive",
  "ready_to_generate",
  "queued",
  "ready_for_review",
  "approved",
  "rejected",
];

export const STATUS_FACET_LABELS: Record<EffectiveStatusKey, string> = {
  no_spec: "No spec",
  awaiting_data: "Awaiting data",
  partially_ready: "Partially ready",
  spec_inactive: "Spec inactive",
  ready_to_generate: "Ready to generate",
  queued: "Queued / generating",
  ready_for_review: "Ready for review",
  approved: "Approved",
  rejected: "Rejected",
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
  // Fields are all there, but the Prod Spec is inactive — it won't generate
  // (auto-enqueue is gated on active), so it must NOT read as "Ready to
  // generate". Its own pill instead, with the activate-it hint.
  if (readiness.reason === "inactive") {
    return { key: "spec_inactive", label: "Spec inactive", tone: "amber", hint: readiness.title + failedNote };
  }
  // ready / auto_off — the fields are all there on an active spec; the
  // auto-gen-off nuance (still manually runnable) rides in the hint.
  return { key: "ready_to_generate", label: "Ready to generate", tone: "green", hint: readiness.title + failedNote };
}

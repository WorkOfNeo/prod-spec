import type { MissingDetailField } from "@/lib/styles/detail-fields";
import type { OutputReadiness } from "@/lib/styles/output-readiness";
import type { CurrentOutput, OutputState } from "@/lib/outputs/current-outputs";
import { SLOT_STATE_PRIORITY } from "@/lib/outputs/current-outputs";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { MAX_EAN_ATTEMPTS, eanFloated } from "@/lib/po/ean-status-meta";

// =====================================================
// Output Readiness Notice — the single, role-aware selector that merges the
// whole output pipeline (SharePoint → PO → EANs → fields → generation →
// review) into ONE model: a headline pill + an ordered ladder of steps. It
// ENHANCES the existing "X of Y outputs ready" pill; it does NOT replace any
// data model. Pure: no React, no DB. Surfaces feed it what they already load.
//
// Role model (from the approved design — followed exactly):
//   • A missing REQUIRED ("req") field is Monday data the REVIEWER adds
//     themselves. Copy says it comes from Monday and to add it there; the
//     output then generates automatically. NEVER "an admin fills these".
//   • Only SCRAPE / PIPELINE failures route to ADMIN: SharePoint connection
//     error, no PO file in the drive (incl. connected-but-empty folder),
//     3-strike PO float, no prod spec linked, prod spec has no outputs,
//     render / barcode failure.
//   • Neither role can approve a style with a blocked / placeholder output.
// =====================================================

export type ReadinessTone = "green" | "amber" | "red" | "sky" | "zinc";
export type ReadinessRole = "ADMIN" | "REVIEWER";
export type StepOwner = "REVIEWER" | "ADMIN" | "SYSTEM";
export type StepStatus = "ok" | "waiting" | "blocked" | "running" | "idle";

export type ReadinessAction = {
  label: string;
  // Surfaces map a `key` to a real href (Monday URL, prod-spec URL, /po-eans).
  // The selector never knows URLs; it only declares intent.
  key?: ReadinessActionKey;
  kind?: "primary" | "default" | "link";
};

export type ReadinessActionKey =
  | "openMonday"
  | "pinFieldInSpec"
  | "openProdSpec"
  | "setBusinessArea"
  | "openPoEans"
  | "openSuppliersDrive"
  | "rerun"
  | "review";

export type ReadinessStep = {
  key: string;
  status: StepStatus;
  tone: ReadinessTone;
  title: string;
  detail: string;
  // Missing Monday fields the reviewer adds (only on field-waiting steps).
  fields?: MissingDetailField[];
  // Per-output breakdown for a field-waiting step: each waiting output and
  // the exact fields it needs. Lets the panel list "Wash care label · Wash
  // care, Composition" the way the design shows.
  outputs?: { name: string; fields: MissingDetailField[] }[];
  owner?: StepOwner;
  actions?: ReadinessAction[];
};

export type ReadinessNotice = {
  // Pill text — harder-blocker-wins priority. The "X of Y ready" count only
  // becomes the headline when nothing harder outranks it.
  headline: string;
  tone: ReadinessTone;
  ready: number;
  total: number;
  // The whole ladder, ordered SharePoint/PO → spec → fields → generation →
  // review → excluded.
  steps: ReadinessStep[];
};

// The EAN-pipeline statuses, from prisma StyleEanStatus. Kept as a string so
// callers can pass the raw enum value without importing the generated client.
export type EanStatusValue =
  | "NONE"
  | "PENDING"
  | "RESOLVING"
  | "RESOLVED"
  | "PARTIAL"
  | "PO_FOUND_NO_EANS"
  | "PO_NOT_FOUND"
  | "STYLE_NOT_IN_PO"
  | "ERROR"
  | (string & {});

export type ReadinessNoticeInput = {
  // Always supplied — the source/PO/SharePoint stage + spec presence. Every
  // surface already has (or can cheaply add) these.
  eanStatus: EanStatusValue;
  eanAttempts: number;
  poNumber?: string | null;
  poFileName?: string | null;
  hasProdSpec: boolean;
  prodSpecHasOutputs: boolean;

  // Rich case — the REVIEW page / cards have full state-aware outputs. Prefer
  // this when present.
  currentOutputs?: CurrentOutput[];
  // Lighter case — the /styles LIST has readiness (ready/missing) but not full
  // per-output generation state.
  outputReadiness?: OutputReadiness[];
  // List-only signals to upgrade the lighter case: has any PDF been generated,
  // and the newest job's status (for render/barcode failure detection).
  hasPdfs?: boolean;
  latestJobStatus?: string | null;
};

// ---------------------------------------------------------------------------
// Tone helpers
// ---------------------------------------------------------------------------

const TONE_RANK: Record<ReadinessTone, number> = {
  red: 4, // blocked / error — hardest
  amber: 3, // waiting on source or missing fields
  sky: 2, // in progress
  green: 1, // all ready
  zinc: 0, // not applicable
};

function harder(a: ReadinessTone, b: ReadinessTone): ReadinessTone {
  return TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Normaliser — both the rich (CurrentOutput[]) and the light (OutputReadiness[])
// cases collapse to this shared shape so the steps are identical.
// ---------------------------------------------------------------------------

type NormalizedOutputs = {
  total: number; // declared, EXCLUDING excluded outputs
  ready: number; // can generate / generated & not blocked
  excluded: number;
  // Outputs waiting on Monday fields, with their exact missing fields.
  waitingOnFields: { name: string; fields: MissingDetailField[] }[];
  generating: number; // GENERATING / READY_TO_GENERATE
  toReview: number; // TO_REVIEW
  approved: number;
  rejected: number;
  blocked: number; // placeholder artwork → approval blocked for both roles
};

const EXCLUDED_STATE = "EXCLUDED" as const;

function isExcluded(state: OutputState | string): boolean {
  return state === EXCLUDED_STATE;
}

function normalizeFromCurrent(outputs: CurrentOutput[]): NormalizedOutputs {
  const n: NormalizedOutputs = {
    total: 0,
    ready: 0,
    excluded: 0,
    waitingOnFields: [],
    generating: 0,
    toReview: 0,
    approved: 0,
    rejected: 0,
    blocked: 0,
  };
  // Collapse to OUTPUT SLOTS (base variantKey) so a multi-document output
  // (carton X-of-Y per size/colour) counts ONCE — matching rollupOutputSlots on
  // the review page, so the notice's "X of Y" never balloons with documents. A
  // slot's state is the most-actionable among its documents.
  const byBase = new Map<string, CurrentOutput[]>();
  for (const o of outputs) {
    const b = baseVariantKey(o.variantKey);
    const arr = byBase.get(b);
    if (arr) arr.push(o);
    else byBase.set(b, [o]);
  }
  for (const docs of byBase.values()) {
    const slotState =
      SLOT_STATE_PRIORITY.find((s) => docs.some((d) => d.state === s)) ?? "AWAITING_DATA";
    if (isExcluded(slotState)) {
      n.excluded += 1;
      continue;
    }
    n.total += 1;
    switch (slotState) {
      case "AWAITING_DATA": {
        const waiting = docs.find((d) => d.state === "AWAITING_DATA") ?? docs[0];
        n.waitingOnFields.push({ name: waiting.name, fields: waiting.missing });
        break;
      }
      case "READY_TO_GENERATE":
      case "GENERATING":
        n.generating += 1;
        n.ready += 1;
        break;
      case "TO_REVIEW":
        n.toReview += 1;
        n.ready += 1;
        break;
      case "APPROVED":
        n.approved += 1;
        n.ready += 1;
        break;
      case "REJECTED":
        n.rejected += 1;
        break;
      case "BLOCKED":
        n.blocked += 1;
        break;
    }
  }
  return n;
}

function normalizeFromReadiness(
  readiness: OutputReadiness[],
  hasPdfs: boolean,
): NormalizedOutputs {
  const n: NormalizedOutputs = {
    total: readiness.length,
    ready: 0,
    excluded: 0,
    waitingOnFields: [],
    generating: 0,
    toReview: 0,
    approved: 0,
    rejected: 0,
    blocked: 0,
  };
  for (const o of readiness) {
    if (o.ready) {
      n.ready += 1;
      // Light case can't distinguish generated/review — if any PDF exists we
      // treat ready outputs as "to review", else queued for generation.
      if (hasPdfs) n.toReview += 1;
      else n.generating += 1;
    } else {
      n.waitingOnFields.push({ name: o.name, fields: o.missing });
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Step builders for the EAN / PO / SharePoint stage.
// ---------------------------------------------------------------------------

// Returns the single source-stage step (or null when the source is settled and
// shouldn't show its own line — RESOLVED with EANs in hand). Floated rows
// (≥ MAX_EAN_ATTEMPTS in a retryable state) override the plain status.
function sourceStep(input: ReadinessNoticeInput): ReadinessStep | null {
  const { eanStatus, eanAttempts, poNumber, poFileName } = input;
  const po = poNumber ?? null;

  // 3-strike float — admin must manually re-trigger on /po-eans. Takes
  // precedence over the underlying retryable status.
  if (eanFloated(eanStatus, eanAttempts)) {
    return {
      key: "po-floated",
      status: "blocked",
      tone: "red",
      title: "Needs attention",
      detail: `PO lookup gave up after ${MAX_EAN_ATTEMPTS} attempts; this row floated out of the auto-retry queue. Re-trigger it manually.`,
      owner: "ADMIN",
      actions: [{ label: "Re-resolve on /po-eans", key: "openPoEans", kind: "default" }],
    };
  }

  switch (eanStatus) {
    case "NONE":
      return {
        key: "po-none",
        status: "waiting",
        tone: "amber",
        title: "No PO number yet",
        detail:
          "No PO on Monday, so EAN-dependent outputs can't resolve. Add the PO number on Monday; non-EAN outputs may still be ready.",
        owner: "REVIEWER",
        actions: [{ label: "Open on Monday", key: "openMonday", kind: "default" }],
      };
    case "PENDING":
    case "RESOLVING":
      return {
        key: "po-resolving",
        status: "running",
        tone: "sky",
        title: "Looking up PO…",
        detail:
          "PO set; searching the SharePoint Suppliers drive and parsing barcodes. Transient — auto-advances.",
        owner: "SYSTEM",
      };
    case "ERROR":
      return {
        key: "po-error",
        status: "blocked",
        tone: "red",
        title: "SharePoint error",
        detail:
          "Couldn't reach SharePoint (auth / connection). Not the same as a missing file — retry and check the Graph credentials.",
        owner: "ADMIN",
        actions: [{ label: "Re-resolve on /po-eans", key: "openPoEans", kind: "default" }],
      };
    case "PO_NOT_FOUND":
      return {
        key: "po-not-found",
        status: "blocked",
        tone: "red",
        title: "No PO file found",
        detail: po
          ? `SharePoint connected · no PDF matching ${po} in the Suppliers drive (folder empty or wrong filename).`
          : "SharePoint connected · no matching PO PDF in the Suppliers drive (folder empty or wrong filename).",
        owner: "ADMIN",
        actions: [
          { label: "Open Suppliers drive", key: "openSuppliersDrive", kind: "default" },
          { label: "Re-resolve on /po-eans", key: "openPoEans", kind: "link" },
        ],
      };
    case "STYLE_NOT_IN_PO":
      return {
        key: "po-style-not-in-po",
        status: "blocked",
        tone: "red",
        title: "Style not in PO",
        detail:
          "The PO PDF was found and carries barcodes, but none of its style sections matches this style number. Check the PO; re-resolve once corrected.",
        owner: "ADMIN",
        actions: [{ label: "Re-resolve on /po-eans", key: "openPoEans", kind: "default" }],
      };
    case "PO_FOUND_NO_EANS":
      return {
        key: "po-no-barcodes",
        status: "waiting",
        tone: "amber",
        title: "Waiting on PO barcodes",
        detail: poFileName
          ? `Matched ${poFileName}, but it has no barcode / EAN page yet — supplier adds it later. Auto-retries up to ${MAX_EAN_ATTEMPTS}×.`
          : `PO PDF found, but it has no barcode / EAN page yet — supplier adds it later. Auto-retries up to ${MAX_EAN_ATTEMPTS}×.`,
        owner: "SYSTEM",
      };
    case "PARTIAL":
      return {
        key: "po-partial",
        status: "waiting",
        tone: "amber",
        title: "Some sizes missing EANs",
        detail:
          "Barcodes parsed, but not every size matched a code. EAN-dependent outputs for the unmatched sizes wait until the PO is completed.",
        owner: "SYSTEM",
      };
    case "RESOLVED":
      // Settled source — represented by a quiet "ok" line so the ladder still
      // shows the stage as cleared.
      return {
        key: "po-resolved",
        status: "ok",
        tone: "green",
        title: "PO & barcodes resolved",
        detail: poFileName
          ? `Matched ${poFileName} · EANs resolved.`
          : "PO found, sizes matched, EANs resolved.",
        owner: "SYSTEM",
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Step builder for the prod-spec presence stage.
// ---------------------------------------------------------------------------

function prodSpecStep(input: ReadinessNoticeInput): ReadinessStep | null {
  if (!input.hasProdSpec) {
    return {
      key: "no-prod-spec",
      status: "blocked",
      tone: "red",
      title: "No prod spec",
      detail:
        "No spec linked — usually a missing Business Area. Nothing can generate. Set Customer + Business Area on the style; the spec auto-matches.",
      owner: "ADMIN",
      actions: [{ label: "Set Business Area", key: "setBusinessArea", kind: "default" }],
    };
  }
  if (!input.prodSpecHasOutputs) {
    return {
      key: "spec-no-outputs",
      status: "blocked",
      tone: "red",
      title: "Spec has no outputs",
      detail:
        "Spec linked but zero outputs configured (or all disabled). Add outputs in the Prod Spec before anything can generate.",
      owner: "ADMIN",
      actions: [{ label: "Add outputs", key: "openProdSpec", kind: "default" }],
    };
  }
  return {
    key: "prod-spec-ok",
    status: "ok",
    tone: "green",
    title: "Prod spec linked",
    detail: "A prod spec is linked with enabled outputs.",
    owner: "SYSTEM",
  };
}

// ---------------------------------------------------------------------------
// Output-stage steps (fields / generation / review / blocked / excluded),
// built from the normalised summary. role-aware copy on the field step only.
// ---------------------------------------------------------------------------

function outputSteps(
  n: NormalizedOutputs,
  role: ReadinessRole,
  latestJobStatus: string | null | undefined,
): ReadinessStep[] {
  const steps: ReadinessStep[] = [];

  // Render / barcode failure on the newest job — admin sees the error & re-runs.
  if (latestJobStatus === "RENDER_FAILED" || latestJobStatus === "BARCODE_FAILED") {
    steps.push({
      key: "render-failed",
      status: "blocked",
      tone: "red",
      title: "Render failed",
      detail:
        latestJobStatus === "BARCODE_FAILED"
          ? "A barcode failed to encode — often an invalid EAN check digit. See the error and re-run."
          : "Rendering an output threw. See the error and re-run.",
      owner: "ADMIN",
      actions: [{ label: "Re-run", key: "rerun", kind: "default" }],
    });
  }

  // Blocked placeholder artwork — approval blocked for BOTH roles.
  if (n.blocked > 0) {
    steps.push({
      key: "blocked",
      status: "blocked",
      tone: "red",
      title: n.blocked === 1 ? "1 output blocked" : `${n.blocked} outputs blocked`,
      detail:
        "Generated but contains placeholder artwork (missing artwork / no carton EAN). Review-safe, never print-safe — approval is blocked until it's fixed and re-run.",
      owner: "ADMIN",
      actions: [{ label: "Re-run", key: "rerun", kind: "default" }],
    });
  }

  // Waiting on Monday fields — REVIEWER's job to add them on Monday.
  if (n.waitingOnFields.length > 0) {
    const count = n.waitingOnFields.length;
    const reviewerDetail =
      "These required fields are blank on the Monday board. Add them there — no blank PDFs are produced, and the output generates automatically once the field lands.";
    const adminDetail =
      "These won't generate until the fields below land on Monday or are pinned in the spec.";
    steps.push({
      key: "awaiting-fields",
      status: "waiting",
      tone: "amber",
      title:
        count === 1
          ? "1 output needs data from Monday"
          : `${count} outputs need data from Monday`,
      detail: role === "REVIEWER" ? reviewerDetail : adminDetail,
      outputs: n.waitingOnFields,
      // Flat union of all missing fields, deduped by key — handy for a compact
      // chip row when a surface doesn't render the per-output breakdown.
      fields: dedupeFields(n.waitingOnFields.flatMap((o) => o.fields)),
      owner: "REVIEWER",
      actions:
        role === "REVIEWER"
          ? [{ label: "Open on Monday", key: "openMonday", kind: "default" }]
          : [
              { label: "Open on Monday", key: "openMonday", kind: "default" },
              { label: "Pin field in spec", key: "pinFieldInSpec", kind: "link" },
            ],
    });
  }

  // In-progress generation.
  if (n.generating > 0) {
    steps.push({
      key: "generating",
      status: "running",
      tone: "sky",
      title:
        n.generating === 1 ? "1 output generating" : `${n.generating} outputs generating`,
      detail:
        "A job is rendering these outputs; they appear here automatically when done.",
      owner: "SYSTEM",
    });
  }

  // Ready for a decision.
  if (n.toReview > 0) {
    steps.push({
      key: "to-review",
      status: "ok",
      tone: "green",
      title:
        n.toReview === 1
          ? "1 output ready for review"
          : `${n.toReview} outputs ready for review`,
      detail: "Clean PDF generated, pending a reviewer decision.",
      owner: "REVIEWER",
      actions: [{ label: "Review", key: "review", kind: "primary" }],
    });
  }

  // Rejected — needs a fix + re-run.
  if (n.rejected > 0) {
    steps.push({
      key: "rejected",
      status: "blocked",
      tone: "red",
      title: n.rejected === 1 ? "1 output rejected" : `${n.rejected} outputs rejected`,
      detail: "Rejected in review — fix the data and re-run.",
      owner: "ADMIN",
      actions: [{ label: "Re-run", key: "rerun", kind: "default" }],
    });
  }

  // Approved.
  if (n.approved > 0) {
    steps.push({
      key: "approved",
      status: "ok",
      tone: "green",
      title:
        n.approved === 1 ? "1 output approved" : `${n.approved} outputs approved`,
      detail: "Approved and ready to send.",
      owner: "SYSTEM",
    });
  }

  // Excluded — not applicable, counted out of the total.
  if (n.excluded > 0) {
    steps.push({
      key: "excluded",
      status: "idle",
      tone: "zinc",
      title:
        n.excluded === 1
          ? "1 output not applicable"
          : `${n.excluded} outputs not applicable`,
      detail:
        "Skipped by a product rule (e.g. socks / shoes → no wash care). Counts out of the total, not a failure — nothing to review.",
      owner: "SYSTEM",
    });
  }

  return steps;
}

function dedupeFields(fields: MissingDetailField[]): MissingDetailField[] {
  const seen = new Set<string>();
  const out: MissingDetailField[] = [];
  for (const f of fields) {
    if (seen.has(f.field)) continue;
    seen.add(f.field);
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Headline — harder blocker wins; the count is the fallback headline.
// ---------------------------------------------------------------------------

function buildHeadline(
  steps: ReadinessStep[],
  n: NormalizedOutputs,
  sourceBlocking: boolean,
): { headline: string; tone: ReadinessTone } {
  // Hardest blocking step (red), then waiting (amber), then running (sky).
  let tone: ReadinessTone = "green";
  for (const s of steps) tone = harder(tone, s.tone);

  const count = `${n.ready} of ${n.total} ready`;

  // A blocking source/spec/render/placeholder step provides the headline.
  const red = steps.find((s) => s.tone === "red");
  if (red) return { headline: red.title, tone: "red" };

  const amber = steps.find((s) => s.tone === "amber");
  if (amber) {
    // The count moves into the steps; the cause becomes the headline — UNLESS
    // it's a pure missing-fields case AND nothing else stalls the source, in
    // which case the count IS the most informative headline.
    if (amber.key === "awaiting-fields" && !sourceBlocking && n.total > 0) {
      return { headline: count, tone: "amber" };
    }
    return { headline: amber.title, tone: "amber" };
  }

  const sky = steps.find((s) => s.tone === "sky");
  if (sky) {
    if (n.total > 0 && n.ready < n.total) return { headline: count, tone: "sky" };
    return { headline: sky.title, tone: "sky" };
  }

  // Everything clear.
  if (n.total === 0) {
    // No declared outputs and nothing blocking above — neutral.
    return { headline: "No outputs", tone: "zinc" };
  }
  if (n.ready === n.total) {
    return { headline: n.total === 1 ? "Ready" : `All ${n.total} ready`, tone: "green" };
  }
  return { headline: count, tone };
}

// ---------------------------------------------------------------------------
// The selector.
// ---------------------------------------------------------------------------

export function styleReadinessNotice(
  input: ReadinessNoticeInput,
  role: ReadinessRole,
): ReadinessNotice {
  const steps: ReadinessStep[] = [];

  // 1. Source / PO / SharePoint stage.
  const src = sourceStep(input);
  const sourceBlocking = src != null && (src.tone === "red" || src.tone === "amber");
  if (src) steps.push(src);

  // 2. Prod-spec presence stage. Short-circuits the rest when missing — there
  //    are no meaningful outputs to report. We still show the source line above.
  const spec = prodSpecStep(input);
  const specBlocking = spec != null && spec.tone === "red";
  if (spec) steps.push(spec);

  // 3. Output stage — only when a spec with outputs exists.
  let n: NormalizedOutputs = {
    total: 0,
    ready: 0,
    excluded: 0,
    waitingOnFields: [],
    generating: 0,
    toReview: 0,
    approved: 0,
    rejected: 0,
    blocked: 0,
  };
  if (!specBlocking) {
    if (input.currentOutputs) {
      n = normalizeFromCurrent(input.currentOutputs);
    } else if (input.outputReadiness) {
      n = normalizeFromReadiness(input.outputReadiness, input.hasPdfs ?? false);
    }
    steps.push(...outputSteps(n, role, input.latestJobStatus));
  }

  const { headline, tone } = buildHeadline(steps, n, sourceBlocking || specBlocking);

  return {
    headline,
    tone,
    ready: n.ready,
    total: n.total,
    steps,
  };
}

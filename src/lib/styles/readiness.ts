// Can a style generate PDFs, and if not, what's blocking it? This mirrors
// the real auto-enqueue gate (see the Monday webhook + import-promotion
// paths): a linked ProdSpec, completionPct ≥ the ProdSpec's threshold, an
// active ProdSpec, and the global auto-generate switch. Computed in one
// place so the styles list and the style detail agree exactly.

export type ReadinessReason =
  | "ready"
  | "auto_off"
  | "incomplete"
  | "partial"
  | "missing_fields"
  | "no_prod_spec"
  | "inactive";
export type ReadinessTone = "ready" | "paused" | "incomplete" | "blocked";

export type Readiness = {
  reason: ReadinessReason;
  tone: ReadinessTone;
  // Compact chip text for the list.
  shortLabel: string;
  // Heading + body for the detail-page banner.
  title: string;
  detail: string;
  threshold: number;
  meetsThreshold: boolean;
  hasProdSpec: boolean;
};

export function computeReadiness(opts: {
  completionPct: number;
  prodSpec: { autoGenerateThresholdPct: number; active: boolean } | null;
  autoGenerateEnabled: boolean;
  // Required detail fields that are empty for this style (labels). Legacy
  // union view — used only when no per-output summary is supplied.
  missingDetailFields?: ReadonlyArray<string>;
  // Per-output generation summary. When present (and the style has outputs)
  // this drives the readiness reason: each output generates as soon as ITS
  // OWN required fields are filled, so a style can be partly ready.
  outputs?: {
    total: number;
    ready: number;
    // Outputs still waiting, with the labels of their empty fields.
    blocking: Array<{ name: string; missing: string[] }>;
  };
}): Readiness {
  const { completionPct, prodSpec, autoGenerateEnabled } = opts;
  const missingDetailFields = opts.missingDetailFields ?? [];
  const threshold = prodSpec?.autoGenerateThresholdPct ?? 100;
  const meetsThreshold = completionPct >= threshold;
  const hasProdSpec = Boolean(prodSpec);
  const base = { threshold, meetsThreshold, hasProdSpec };

  // Order matches the real gate so the message names the FIRST thing that
  // stops generation, not a later one.
  if (!prodSpec) {
    return {
      ...base,
      reason: "no_prod_spec",
      tone: "blocked",
      shortLabel: "No spec",
      title: "No Prod Spec linked",
      detail:
        "Link a Prod Spec (Customer × Business area) on the Prod Spec tab before this style can generate.",
    };
  }

  // ---- Per-output path (preferred): each output gates on its own fields ----
  if (opts.outputs && opts.outputs.total > 0) {
    const { total, ready, blocking } = opts.outputs;
    const waiting = blocking
      .map((b) => `${b.name} (${b.missing.join(", ")})`)
      .join("; ");
    if (ready === 0) {
      return {
        ...base,
        reason: "incomplete",
        tone: "incomplete",
        shortLabel: "Not ready",
        title: `Not ready — 0 of ${total} outputs have their fields`,
        detail: `Each output generates as soon as its own required fields are filled. Waiting on: ${waiting}.`,
      };
    }
    if (ready < total) {
      return {
        ...base,
        reason: "partial",
        tone: "incomplete",
        shortLabel: `${ready}/${total} ready`,
        title: `${ready} of ${total} outputs ready`,
        detail: `${ready} output${ready === 1 ? "" : "s"} can generate now; the rest follow as their fields land. Waiting on: ${waiting}.`,
      };
    }
    // ready === total → fall through to the active / auto-generate checks.
  } else {
    // ---- Legacy union path (no per-output summary supplied) ----
    if (!meetsThreshold) {
      return {
        ...base,
        reason: "incomplete",
        tone: "incomplete",
        shortLabel: "Not ready",
        title: `Not ready — ${completionPct}% of required columns filled`,
        detail: `Fill the missing required columns below to reach the ${threshold}% threshold this Prod Spec needs.`,
      };
    }
    if (missingDetailFields.length > 0) {
      return {
        ...base,
        reason: "missing_fields",
        tone: "incomplete",
        shortLabel: "Missing fields",
        title: `Not ready — ${missingDetailFields.length} required field${
          missingDetailFields.length === 1 ? "" : "s"
        } empty`,
        detail: `These required detail fields are empty: ${missingDetailFields.join(", ")}.`,
      };
    }
  }

  if (!prodSpec.active) {
    return {
      ...base,
      reason: "inactive",
      tone: "blocked",
      shortLabel: "Inactive",
      title: "Outputs ready — but the Prod Spec is inactive",
      detail:
        "Every output has the fields it needs, yet this style's Prod Spec is inactive. Activate it on the Prod Spec tab to allow generation.",
    };
  }
  if (!autoGenerateEnabled) {
    return {
      ...base,
      reason: "auto_off",
      tone: "paused",
      shortLabel: "Auto off",
      title: "Ready — but automatic generation is OFF",
      detail:
        "Ready on an active Prod Spec, but auto-generation is switched off globally in Settings. It won't run on sync until you turn it on (you can still Re-run manually).",
    };
  }
  return {
    ...base,
    reason: "ready",
    tone: "ready",
    shortLabel: "Ready",
    title: "Ready to generate",
    detail: "Every output has its required fields on an active Prod Spec — new syncs generate automatically.",
  };
}

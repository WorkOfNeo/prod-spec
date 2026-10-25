import type { PillTone } from "@/components/ui/pill";
import type { ThreadEntry } from "@/lib/tickets/thread";

// What the review page (server) hands the review workspace (client). Plain
// data only — the per-output tools and the non-proof panels travel separately
// as already-rendered nodes, keyed by the same item key.

export type ReviewStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "FIXED" | "RESOLVED";

/** One rejection-log thread for an output, split into the comments typed. */
export type ThreadView = {
  ticketId: string;
  status: TicketStatus;
  reporter: string;
  createdAtIso: string;
  updatedAtIso: string;
  entries: ThreadEntry[];
  // Images are served behind the admin log, so reviewers get the count only.
  attachments: { id: string; url: string; fileName: string }[];
  attachmentCount: number;
};

type ListFields = {
  /** The output's variantKey, or a fixed key for a panel. */
  key: string;
  /** The #fragment other pages deep-link to (outputAnchor). */
  anchor: string;
  name: string;
  /** The list section this sits under (the document type, "Earlier generations", …). */
  group: string;
  tone: PillTone;
  statusLabel: string;
};

/** A generated output: a proof to look at and decide on. */
export type ProofItem = ListFields & {
  kind: "proof";
  assetId: string;
  fileName: string | null;
  status: ReviewStatus;
  reviewedAtIso: string | null;
  placeholderCount: number;
  previewUrl: string;
  /** False for the bundle framing (cover / general info). */
  canIgnore: boolean;
  /** Capability chips, e.g. "X of Y", "Multi-style". */
  chips: string[];
  /** The open (not yet resolved) thread, if any. */
  thread: ThreadView | null;
  /** Resolved threads, newest first. */
  pastThreads: ThreadView[];
};

/** Something to read or fill in rather than decide: missing data, an exclusion, the manual trims. */
export type PanelItem = ListFields & { kind: "panel" };

export type ReviewItem = ProofItem | PanelItem;

// The style's Monday "Trims" entries, and the context needed to turn a set of
// declared outputs plus those entries into a manifest.
//
// Trims is an ordinary mapped field (ColumnMapping.trims, board column
// dropdown4__1 by default) so it resolves through the same
// resolveMappedField / effectiveStyleItem chain as every other spec field —
// including the manual-entry fallback, which matters because a hand-created
// style has no Monday row at all.
//
// No db import: callers pass the style they already loaded. The settings side
// of the context (rules, overrides, layout concepts) is loaded by
// required-packaging.ts, which is the module that owns the DB read.

import { parseCustomerConfig } from "@/lib/customers/config";
import { resolveMappedField } from "@/lib/styles/resolved-fields";
import { splitTrimsCell, type TrimRule } from "./classify";
import type { TrimConceptCopyMap } from "./concept-copy";

export type StyleTrimsSource = {
  rawData: unknown;
  customer: { config: unknown };
};

// Monday's entries for this style, verbatim and in board order, de-duplicated
// case-insensitively. Empty when the column is unmapped, unsynced or blank —
// in which case the manifest falls back to exactly the declared output set,
// i.e. today's behaviour.
export function resolveStyleTrimLabels(style: StyleTrimsSource): string[] {
  const mapping = parseCustomerConfig(style.customer?.config).columnMapping;
  return splitTrimsCell(resolveMappedField(style.rawData as never, mapping, "trims"));
}

// Everything the pure assembler needs beyond the outputs themselves. Threaded
// as one object so the runner (which builds its rows inline) and the DB read
// can share the same assembler without either re-deriving the configuration.
export type TrimContext = {
  trimLabels: string[];
  rules: TrimRule[];
  overrides: Record<string, string[]>;
  // Base variantKey -> concept, for the handful of layouts whose NAME cannot be
  // classified. An empty string means "satisfies no trim".
  layoutConcepts: Record<string, string>;
  // Concept -> the wording the cover prints for it (standing note, and the
  // not-delivered / delivered status). Defaults already merged in.
  conceptCopy: TrimConceptCopyMap;
  // Normalised labels whose manually-supplied file has been located in the
  // order folder. Reserved for the delivery-detection pass; absent today, which
  // makes every manual row read as still-to-come.
  manualDelivered?: Set<string>;
};

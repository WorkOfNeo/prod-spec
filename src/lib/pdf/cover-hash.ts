import { createHash } from "node:crypto";

// Cover/GI persistence (WS9 Phase 4). A stable hash of everything the cover
// page RENDERS FROM — deliberately EXCLUDING the generatedAt timestamp (which
// changes every run) — so a re-run can carry an APPROVED cover forward unchanged
// instead of regenerating it. The hash changes only when the real inputs change:
// the general-info markdown/settings, the bundle document list (outputs added/
// removed, or their names/dims), the cover page settings, or the style identity
// printed on the cover sheet.

export type CoverHashDoc = {
  displayName: string;
  widthMm: number;
  heightMm: number;
  fileCount: number | null;
};

export type CoverHashInput = {
  customerName: string;
  businessArea: string | null;
  styleName: string;
  styleNumber: string;
  poNumber: string | null;
  supplierName: string | null;
  // The bundle's document table — ALL current outputs (generated this run +
  // carried-forward approved), so the hash is stable across re-runs when the
  // set is unchanged.
  docs: CoverHashDoc[];
  coverSettings: unknown;
  generalInfo: { markdown: string; settings: unknown } | null;
};

// Deterministic JSON — recursively sorts object keys so a differently-ordered
// (but equal) settings object hashes the same.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function computeCoverHash(input: CoverHashInput): string {
  // Sort docs by a stable key so generated-vs-carried-forward ORDER doesn't
  // affect the hash — only the set + each doc's name/dims/count matter.
  const docs = [...input.docs].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.widthMm - b.widthMm ||
      a.heightMm - b.heightMm ||
      (a.fileCount ?? -1) - (b.fileCount ?? -1),
  );
  const canonical = stableStringify({
    customerName: input.customerName,
    businessArea: input.businessArea ?? null,
    styleName: input.styleName,
    styleNumber: input.styleNumber,
    poNumber: input.poNumber ?? null,
    supplierName: input.supplierName ?? null,
    docs: docs.map((d) => [d.displayName, d.widthMm, d.heightMm, d.fileCount ?? null]),
    coverSettings: input.coverSettings ?? null,
    generalInfo: input.generalInfo
      ? { markdown: input.generalInfo.markdown, settings: input.generalInfo.settings ?? null }
      : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

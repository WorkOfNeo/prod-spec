// DB-free leaf: the shape + safe parser for the competing PO folders stashed on
// an AMBIGUOUS queue row (SupplierSendQueueItem.sharePointFolderMatches, a JSON
// string). Kept dependency-free so both the push lib and the server pages can
// import it without pulling in the Graph/db stack.

// A PO folder that matched (name + link) — surfaced so reviewers can open each
// competing folder and delete the extras until exactly one remains.
export type PoFolderMatch = { name: string; webUrl: string | null };

// Parse the stored JSON string into the list of competing folders. Bad/empty
// input → []. Never throws.
export function parseFolderMatches(raw: string | null | undefined): PoFolderMatch[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((m): m is { name: string; webUrl?: unknown } => !!m && typeof (m as { name?: unknown }).name === "string")
      .map((m) => ({ name: m.name, webUrl: typeof m.webUrl === "string" ? m.webUrl : null }));
  } catch {
    return [];
  }
}

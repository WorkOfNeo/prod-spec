import { db } from "@/lib/db";

// Single source of truth for "which languages does this app currently
// support?" — every translation editor (wash symbols, country names,
// ProdSpec care instructions) calls this and renders one input per row.
//
// Sorted by `sortOrder` so admins control the column order across the
// whole app from /languages. Lightweight: just `code` and `name`, no
// FK joins, no JSON parsing.
export async function listActiveLanguages(): Promise<Array<{ code: string; name: string }>> {
  const rows = await db.language.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { code: true, name: true },
  });
  return rows;
}

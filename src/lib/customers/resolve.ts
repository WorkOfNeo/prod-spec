import { db } from "@/lib/db";
import { parseCustomerConfig, NETTO_GERMANY_DEFAULT_CONFIG } from "./config";

// Resolve which customer owns a given Monday board. Returns null if no
// customer claims the board — callers decide whether to fall back to a
// default or reject the event.
export async function resolveCustomerByBoardId(boardId: string) {
  const candidates = await db.customer.findMany();
  for (const c of candidates) {
    const cfg = parseCustomerConfig(c.config);
    if (cfg.mondayBoardIds.includes(boardId)) return { customer: c, config: cfg };
  }
  return null;
}

export async function ensureNettoGermany() {
  const existing = await db.customer.findUnique({ where: { slug: "netto-germany" } });
  if (existing) return existing;
  return db.customer.create({
    data: {
      slug: "netto-germany",
      name: "Netto Germany",
      config: NETTO_GERMANY_DEFAULT_CONFIG as unknown as object,
    },
  });
}

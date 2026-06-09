// scripts/seed-default-column-mapping.ts
//
//   npm run seed-column-mapping
//
// Walks every active Customer and merges STYLES_BOARD_COLUMN_MAPPING
// into their stored `config.columnMapping`. Per-customer overrides are
// preserved — only EMPTY fields get filled in. Re-runs are no-ops once
// every field is either set or defaulted.
//
// Why a script when parseCustomerConfig already merges defaults at
// read time? The customer-admin UI renders the *raw* JSON from the DB
// (not the parsed shape), so without this script the JSON editor
// shows blank fields and admins can't see what's defaulting. Running
// this once makes the data self-describing.

import { db } from "@/lib/db";
import {
  STYLES_BOARD_COLUMN_MAPPING,
  type ColumnMapping,
} from "@/lib/customers/config";

async function main() {
  const customers = await db.customer.findMany({
    where: { active: true },
    select: { id: true, slug: true, name: true, config: true },
  });

  let updated = 0;
  let unchanged = 0;
  const defaults = STYLES_BOARD_COLUMN_MAPPING;
  const defaultEntries = Object.entries(defaults).filter(([, v]) => Boolean(v)) as Array<[
    keyof ColumnMapping,
    string,
  ]>;

  for (const c of customers) {
    const raw = (c.config ?? {}) as { columnMapping?: Partial<ColumnMapping> };
    const mapping: Partial<ColumnMapping> = { ...(raw.columnMapping ?? {}) };

    let changed = false;
    for (const [field, defaultColumnId] of defaultEntries) {
      const cur = mapping[field];
      if (cur && cur.length > 0) continue;
      mapping[field] = defaultColumnId;
      changed = true;
    }
    if (!changed) {
      unchanged++;
      continue;
    }

    await db.customer.update({
      where: { id: c.id },
      data: { config: { ...(raw as object), columnMapping: mapping } as object },
    });
    updated++;
    console.log("  ✓", c.name, "(" + c.slug + ")");
  }

  console.log(
    "\nDone. " + updated + " customer(s) updated, " + unchanged + " already complete.",
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

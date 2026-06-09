// scripts/seed-washsymbol-monday-values.ts
//
//   npm run seed-washsymbol-monday
//
// Canonical seed for the full wash-care library. Each Monday phrase
// the operator pasted maps to a stable `code` + a human-readable
// `name` (= the Monday phrase verbatim) + `mondayValue` (= the same).
//
// Behaviour:
//   - Existing code → name + mondayValue are reconciled if they drift
//   - Missing code → row inserted with empty SVG. Add artwork later at
//     /settings/washcare-symbols.
//
// Idempotent: re-running with the same list is a no-op once everything
// is in sync. The resolveWashCode helper on the Edit page normalises
// trailing punctuation and whitespace, so "Wash at or below 30℃." and
// "Wash at or below 30℃" both resolve to the same row.
//
// NOT renamed by this script (intentionally):
//   - bleach_oxygen ("Oxygen bleach only") — pre-existing row, kept
//     without a mondayValue so it doesn't conflict with the new
//     bleach_non_chlorine entry. Operators can choose to deactivate it.

import { db } from "@/lib/db";

const SEED: Array<{ code: string; name: string }> = [
  // ─── Wash temperatures / modes ─────────────────────────────────
  { code: "wash_machine",            name: "Machine Wash" },
  { code: "wash_permanent_press",    name: "Machine Wash- Permanent Press" },
  { code: "wash_delicate",           name: "Machine Wash- Delicate" },
  { code: "wash_no",                 name: "Do Not Wash" },
  { code: "wash_hand",               name: "Hand Wash only" },
  { code: "wash30",                  name: "Wash at or below 30℃" },
  { code: "wash40",                  name: "Wash at or below 40℃" },
  { code: "wash50",                  name: "Wash at or below 50℃" },
  { code: "wash60",                  name: "Wash at or below 60℃" },
  { code: "wash70",                  name: "Wash at or below 70℃" },
  { code: "wash90",                  name: "Wash at or below 90℃" },
  { code: "wash95",                  name: "Wash at or below 95℃" },

  // ─── Bleach ────────────────────────────────────────────────────
  { code: "bleach",                  name: "Bleach" },
  { code: "bleach_no",               name: "Do Not Bleach" },
  { code: "bleach_non_chlorine",     name: "Non-Chlorine Bleach" },
  { code: "bleach_chlorine",         name: "Chlorine Bleach" },

  // ─── Tumble dry ────────────────────────────────────────────────
  { code: "tumble_no",               name: "Do Not Tumble Dry" },
  { code: "tumble_normal",           name: "Tumble Dry" },
  { code: "tumble_low",              name: "Tumble Dry- Low" },
  { code: "tumble_medium",           name: "Tumble Dry- Medium" },
  { code: "tumble_high",             name: "Tumble Dry- High" },
  { code: "tumble_no_heat",          name: "Tumble Dry- No Heat" },
  { code: "tumble_permanent_press",  name: "Tumble Dry- Permanent Press" },
  { code: "tumble_delicate",         name: "Tumble Dry- Delicate" },

  // ─── Iron / steam ──────────────────────────────────────────────
  { code: "iron_any",                name: "Iron- Any Temperature" },
  { code: "iron_low",                name: "Iron- Low Temperature" },
  { code: "iron_medium",             name: "Iron- Medium Temperature" },
  { code: "iron_high",               name: "Iron- High Temperature" },
  { code: "iron_no",                 name: "Do Not Iron" },
  { code: "steam",                   name: "Steam" },
  { code: "steam_no",                name: "Do Not Steam" },

  // ─── Wet clean ─────────────────────────────────────────────────
  { code: "wetclean",                name: "Wet Clean" },
  { code: "wetclean_delicate",       name: "Wet Clean- Delicate" },
  { code: "wetclean_very_delicate",  name: "Wet Clean- Very Delicate" },
  { code: "wetclean_no",             name: "Do Not Wet Clean" },

  // ─── Dry clean ─────────────────────────────────────────────────
  { code: "dryclean",                          name: "Dry Clean" },
  { code: "dryclean_no",                       name: "Do Not Dry Clean" },
  { code: "dryclean_any_solvent",              name: "Dry Clean- Any Solvent" },
  { code: "dryclean_petroleum",                name: "Dry Clean- Petroleum Only" },
  { code: "dryclean_petroleum_delicate",       name: "Dry Clean- Petroleum- Delicate" },
  { code: "dryclean_petroleum_very_delicate",  name: "Dry Clean- Petroleum- Very Delicate" },
  { code: "dryclean_no_trichloroethylene",                 name: "Any Solvent except Trichloroethylene" },
  { code: "dryclean_no_trichloroethylene_delicate",        name: "Any Solvent except Trichloroethylene, Delicate" },
  { code: "dryclean_no_trichloroethylene_very_delicate",   name: "Any Solvent except Trichloroethylene, Very Delicate" },
  { code: "dryclean_short_cycle",              name: "Dry Clean- Short Cycle" },
  { code: "dryclean_reduced_moisture",         name: "Dry Clean- Reduced Moisture" },
  { code: "dryclean_no_steam",                 name: "Dry Clean- No Steam" },
  { code: "dryclean_low_heat",                 name: "Dry Clean- Low Heat" },

  // ─── Natural drying ────────────────────────────────────────────
  { code: "dry_natural",             name: "Natural Dry" },
  { code: "dry_flat",                name: "Dry Flat" },
  { code: "dry_flat_shade",          name: "Dry Flat in Shade" },
  { code: "dry_shade",               name: "Dry in Shade" },
  { code: "dry_drip",                name: "Drip Dry" },
  { code: "dry_drip_shade",          name: "Drip Dry in Shade" },
  { code: "dry_hang",                name: "Hang to Dry" },
  { code: "dry_no",                  name: "Do Not Dry" },
  { code: "dry_line",                name: "Line Dry" },
  { code: "wring",                   name: "Wring" },
  { code: "wring_no",                name: "Do Not Wring" },
];

async function main() {
  // Sanity-check the seed: no duplicate codes, no duplicate names.
  const seenCodes = new Set<string>();
  const seenNames = new Set<string>();
  for (const r of SEED) {
    if (seenCodes.has(r.code)) throw new Error(`Duplicate code in SEED: ${r.code}`);
    if (seenNames.has(r.name)) throw new Error(`Duplicate name in SEED: ${r.name}`);
    seenCodes.add(r.code);
    seenNames.add(r.name);
  }

  let inserted = 0;
  let renamed = 0;
  let mondayChanged = 0;
  let inSync = 0;

  for (const row of SEED) {
    const mondayValue = row.name; // name === mondayValue per user spec
    const existing = await db.washSymbol.findUnique({ where: { code: row.code } });
    if (!existing) {
      await db.washSymbol.create({
        data: {
          code: row.code,
          name: row.name,
          mondayValue,
          svg: null,
          active: true,
        },
      });
      inserted++;
      console.log(`  + ${row.code.padEnd(40)}  ${JSON.stringify(row.name)}`);
      continue;
    }
    const data: { name?: string; mondayValue?: string } = {};
    if (existing.name !== row.name) data.name = row.name;
    if (existing.mondayValue !== mondayValue) data.mondayValue = mondayValue;
    if (!data.name && !data.mondayValue) {
      inSync++;
      continue;
    }
    await db.washSymbol.update({ where: { code: row.code }, data });
    if (data.name) renamed++;
    if (data.mondayValue) mondayChanged++;
    console.log(
      `  ✎ ${row.code.padEnd(40)}  ${
        data.name ? `renamed → ${JSON.stringify(row.name)}` : ""
      }${data.name && data.mondayValue ? "  " : ""}${
        data.mondayValue ? `mondayValue = ${JSON.stringify(mondayValue)}` : ""
      }`,
    );
  }

  console.log(
    `\nDone. ${inserted} inserted, ${renamed} renamed, ${mondayChanged} mondayValue updated, ${inSync} already in sync.`,
  );
  console.log(
    `\nThe ${inserted} new codes ship without SVG. Add artwork at /settings/washcare-symbols when ready.`,
  );

  // Surface anything in the DB that ISN'T in the seed — operator might
  // want to deactivate legacy rows (e.g. bleach_oxygen) now that there's
  // a richer canonical library.
  const allDb = await db.washSymbol.findMany({ select: { code: true, name: true, active: true } });
  const orphans = allDb.filter((r) => !seenCodes.has(r.code));
  if (orphans.length > 0) {
    console.log(`\nNot in seed (${orphans.length} legacy / custom rows still in DB):`);
    for (const o of orphans) {
      console.log(`  · ${o.code.padEnd(40)}  ${o.active ? "active" : "inactive"}  ${JSON.stringify(o.name)}`);
    }
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

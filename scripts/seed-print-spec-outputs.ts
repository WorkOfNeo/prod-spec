import { db } from "@/lib/db";
import { ALL_PRINT_SPECS } from "@/lib/pdf/print-spec-catalog";
import { PRINT_SPEC_VARIANTS } from "@/lib/pdf/print-spec-variants";
import { parseProdSpecOutputs, type ProdSpecOutput } from "@/lib/prod-spec/config";

// =====================================================
// Seed ProdSpec rows + outputs from the print-spec catalogue.
//
//   npm run seed-print-spec-outputs           # dry run (default) — prints the plan
//   npm run seed-print-spec-outputs -- --apply  # write to the DB
//
// For every (customer × business area) pair in src/print-specs/**:
//   1. match the Customer row (case-insensitive name or slug) and the
//      BusinessArea row (case-insensitive name, unmerged) — NEVER creates
//      customers/areas; those sync from Monday. Unmatched pairs are
//      reported for follow-up.
//   2. ensure a ProdSpec row exists (created inactive, like the Style
//      ingest scaffold — an admin activates after review).
//   3. append one output entry per spec variant not already attached
//      (matched by variantKey = spec id; existing entries are never
//      modified, so admin tweaks survive re-runs — fully idempotent).
//
// outputLanguages is deliberately NOT seeded: spec-driven variants carry
// their exact reference language sets internally, and a ProdSpec-level
// selection would override them (collapsing e.g. the care-instruction
// sheet split). Operators can still set it manually per ProdSpec.
// =====================================================

const APPLY = process.argv.includes("--apply");

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/[öø]/g, "o")
    .replace(/æ/g, "ae")
    .replace(/é/g, "e")
    .replace(/ü/g, "u")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const norm = (s: string) => s.trim().toLowerCase();

// Spec customer names (from the supplier reference PDFs) → Monday account
// names in the Customer table. Grounded in the DB state at authoring time:
// "Netto DK" maps to "Netto ApS & Co. KG" because that row holds the
// hand-built Netto DK Private Label outputs (care-label-01/02) and the
// Netto style volume; "Netto Germany" is the remaining German account —
// CONFIRM that one before activating Netto DE ProdSpecs.
const CUSTOMER_ALIASES: Record<string, string> = {
  "coop 365": "COOP Danmark (Coop 365)",
  "coop dk": "COOP Danmark (fakt kto)",
  dollarstore: "DOLLARSTORE APS",
  europris: "Europris AS",
  "ge-kås ullared": "Ge-kås Ullared AB",
  kaufland: "Kaufland Dienstleistung GmbH & Co. KG",
  "netto dk": "Netto ApS & Co. KG",
  "netto de": "Netto Germany",
  "rema 1000": "REMA 1000 Danmark A/S",
  runsven: "Runsven AB",
  sok: "SOK Palveluässä",
  tokmanni: "Tokmanni Oy",
};

// Spec business-area names → BusinessArea rows. "Loved" and "T2C" have no
// DB row yet (they must arrive via the Monday board sync) — those pairs
// stay unmatched until then.
const AREA_ALIASES: Record<string, string> = {
  "body guide": "Bodyguide",
};

async function main() {
  console.log(`Print-spec output seeding — ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`);

  const [customers, businessAreas] = await Promise.all([
    db.customer.findMany(),
    db.businessArea.findMany({ where: { mergedIntoId: null } }),
  ]);

  const variantByKey = new Map(PRINT_SPEC_VARIANTS.map((v) => [v.key, v]));

  // Group the catalogue by customer × business area.
  const groups = new Map<string, { customer: string; area: string; specIds: string[] }>();
  for (const spec of ALL_PRINT_SPECS) {
    const key = `${norm(spec.customer)}::${norm(spec.businessArea)}`;
    const g = groups.get(key) ?? { customer: spec.customer, area: spec.businessArea, specIds: [] };
    g.specIds.push(spec.id);
    groups.set(key, g);
  }

  let created = 0;
  let updated = 0;
  let outputsAdded = 0;
  const unmatched: string[] = [];

  for (const g of [...groups.values()].sort((a, b) => a.customer.localeCompare(b.customer))) {
    const customerName = CUSTOMER_ALIASES[norm(g.customer)] ?? g.customer;
    const areaName = AREA_ALIASES[norm(g.area)] ?? g.area;
    const customer = customers.find(
      (c) => norm(c.name) === norm(customerName) || c.slug === kebab(customerName),
    );
    const area = businessAreas.find(
      (a) => norm(a.name) === norm(areaName) || norm(a.mondayValue) === norm(areaName),
    );
    if (!customer || !area) {
      unmatched.push(
        `${g.customer} · ${g.area} (${g.specIds.length} specs) — ` +
          `${customer ? "" : `no Customer matching "${g.customer}"`}` +
          `${!customer && !area ? "; " : ""}` +
          `${area ? "" : `no BusinessArea matching "${g.area}"`}`,
      );
      continue;
    }

    const existing = await db.prodSpec.findUnique({
      where: { customerId_businessAreaId: { customerId: customer.id, businessAreaId: area.id } },
    });

    const currentOutputs: ProdSpecOutput[] = existing
      ? parseProdSpecOutputs(existing.outputs)
      : [];
    const have = new Set(currentOutputs.map((o) => o.variantKey));

    const additions: ProdSpecOutput[] = [];
    for (const specId of g.specIds) {
      if (have.has(specId)) continue;
      const variant = variantByKey.get(specId);
      if (!variant) continue; // unreachable while the catalogue registers everything
      additions.push({
        variantKey: specId,
        widthMm: variant.defaultWidthMm,
        heightMm: variant.defaultHeightMm,
        enabled: true,
      });
    }

    const action = existing
      ? additions.length > 0
        ? `update (+${additions.length} outputs, ${currentOutputs.length} kept)`
        : "up to date"
      : `create (inactive) +${additions.length} outputs`;
    console.log(`${g.customer} · ${g.area} → ${action}`);
    for (const a of additions) console.log(`    + ${a.variantKey} (${a.widthMm}×${a.heightMm} mm)`);

    if (!existing) created++;
    else if (additions.length > 0) updated++;
    outputsAdded += additions.length;

    if (APPLY) {
      if (existing) {
        if (additions.length > 0) {
          await db.prodSpec.update({
            where: { id: existing.id },
            data: { outputs: [...currentOutputs, ...additions] as unknown as object },
          });
        }
      } else {
        await db.prodSpec.create({
          data: {
            customerId: customer.id,
            businessAreaId: area.id,
            name: `${customer.name} · ${area.name}`,
            outputs: additions as unknown as object,
            columnMapping: {} as object,
            requiredFields: [] as unknown as object,
            autoGenerateThresholdPct: 100,
            active: false,
          },
        });
      }
    }
  }

  console.log(
    `\nSummary (${APPLY ? "applied" : "dry run"}): ` +
      `${created} ProdSpecs to create, ${updated} to update, ${outputsAdded} output entries to add.`,
  );
  if (unmatched.length > 0) {
    console.log(`\nUNMATCHED customer × business-area pairs (${unmatched.length}) — fix names in Monday/DB and re-run:`);
    for (const u of unmatched) console.log(`  ! ${u}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

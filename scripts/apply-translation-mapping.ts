import { db } from "@/lib/db";
import { parseProdSpecOutputs, type ProdSpecOutput } from "@/lib/prod-spec/config";

// =====================================================
// Apply the customer translation mapping to every ProdSpec.
//
//   npx tsx --env-file=.env scripts/apply-translation-mapping.ts            # dry run
//   npx tsx --env-file=.env scripts/apply-translation-mapping.ts --apply    # write
//
// Source of truth: "Translation mapping - Customer Business Areas.xlsx"
// (sheet "Translations by field") — the per-customer/business-area/field
// language sets. Those sets are already encoded per FIELD in the print
// spec files (src/print-specs/**, FieldSpec.languages), which is strictly
// more precise than any single per-ProdSpec list can be (e.g. Netto DK
// wash care = 9 languages while the Netto DK info area is Danish-only).
//
// The blocker was a blanket outputLanguages = ["en"] backfilled onto every
// ProdSpec row: a non-empty selection OVERRIDES the spec language sets
// (see spec-generic.ts / output-langs.ts), so every output rendered
// English-only. This script clears that blanket override back to []
// — "follow the spec's reference languages" — and leaves any richer,
// operator-chosen selection untouched.
//
// Piggybacked fix: the netto-dk carton-marking outputs were seeded at the
// old static-stub working size (40×60 mm). The specs are dynamic now with
// a 105×148 mm working default — bump rows still sitting on the old size.
// =====================================================

const APPLY = process.argv.includes("--apply");

const NETTO_CARTON_KEYS = new Set([
  "netto-dk-private-label-carton-marking",
  "netto-dk-license-carton-marking",
  "netto-dk-body-guide-carton-marking",
]);

async function main() {
  console.log(
    `Translation-mapping apply — ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`,
  );

  const specs = await db.prodSpec.findMany({
    include: {
      customer: { select: { name: true } },
      businessArea: { select: { name: true } },
    },
    orderBy: { name: "asc" },
  });

  let langCleared = 0;
  let langKept = 0;
  let dimsBumped = 0;

  for (const s of specs) {
    const langs = Array.isArray(s.outputLanguages) ? (s.outputLanguages as unknown[]) : [];
    const isBlanketEn =
      langs.length === 1 && typeof langs[0] === "string" && langs[0].toLowerCase() === "en";
    if (!isBlanketEn && langs.length > 0) langKept++;

    const outputs = parseProdSpecOutputs(s.outputs);
    let outputsChanged = false;
    const nextOutputs: ProdSpecOutput[] = outputs.map((o) => {
      if (NETTO_CARTON_KEYS.has(o.variantKey) && o.widthMm === 40 && o.heightMm === 60) {
        outputsChanged = true;
        return { ...o, widthMm: 105, heightMm: 148 };
      }
      return o;
    });

    if (!isBlanketEn && !outputsChanged) continue;

    const label = `${s.customer?.name ?? "?"} · ${s.businessArea?.name ?? "?"}`;
    const keys = outputs.map((o) => o.variantKey).join(", ") || "no outputs";
    if (isBlanketEn) {
      console.log(`${label}: outputLanguages ["en"] → []  (${keys})`);
      langCleared++;
    }
    if (outputsChanged) {
      console.log(`${label}: carton-marking output 40×60 → 105×148 mm`);
      dimsBumped++;
    }

    if (APPLY) {
      await db.prodSpec.update({
        where: { id: s.id },
        data: {
          ...(isBlanketEn ? { outputLanguages: [] as unknown as object } : {}),
          ...(outputsChanged ? { outputs: nextOutputs as unknown as object } : {}),
        },
      });
    }
  }

  console.log(
    `\nSummary (${APPLY ? "applied" : "dry run"}): ` +
      `${langCleared} blanket ["en"] overrides cleared, ` +
      `${langKept} explicit language selections kept, ` +
      `${dimsBumped} ProdSpecs with carton dims bumped.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

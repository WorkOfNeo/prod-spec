import { db } from "@/lib/db";

// =====================================================
// Seed PLACEHOLDER artwork for the certification marks the Output
// Builder's {{cert:…}} variables reference (and care-label-02 prints
// when a style declares them):
//
//   npm run seed-certificates             # dry run (default) — prints the plan
//   npm run seed-certificates -- --apply  # write to the DB
//
// Idempotent + non-destructive:
//   • row absent             → created with the placeholder SVG, active
//   • row exists, logo empty → placeholder filled in
//   • row exists WITH logo   → NEVER touched (real artwork always wins)
//
// The artwork deliberately screams PLACEHOLDER (dashed border + wording
// baked into the SVG): a successfully rendering placeholder is a valid
// image the placeholder ship-gate cannot count, so the proof itself has
// to carry the warning. Swapping in licensed artwork later is an upload
// at Settings → Certificates — no deploy, and this script will then
// leave the row alone on every re-run.
//
// Names must normalize to the {{cert:…}} source keys (normalizeCertKey:
// "OEKO-TEX" → "oekotex", "FSC" → "fsc") — see CERT_SOURCES in
// src/lib/output-layouts/token-meta.ts.
// =====================================================

const APPLY = process.argv.includes("--apply");

function placeholderSvg(markName: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 70">
  <rect x="1.5" y="1.5" width="137" height="67" rx="6" fill="#fff" stroke="#18181b" stroke-width="3" stroke-dasharray="6 4"/>
  <text x="70" y="30" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#18181b">${markName}&#174;</text>
  <text x="70" y="46" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" letter-spacing="1" fill="#b91c1c">PLACEHOLDER</text>
  <text x="70" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="6.5" fill="#71717a">replace with licensed artwork</text>
</svg>`;
}

const SEEDS = ["OEKO-TEX", "FSC"];

async function main() {
  for (const name of SEEDS) {
    const existing = await db.certificate.findUnique({ where: { name } });
    if (!existing) {
      console.log(`${name}: no row — ${APPLY ? "creating" : "would create"} with placeholder artwork (active)`);
      if (APPLY) {
        await db.certificate.create({ data: { name, logo: placeholderSvg(name), active: true } });
      }
    } else if (!existing.logo) {
      console.log(`${name}: row exists without artwork — ${APPLY ? "filling in" : "would fill in"} the placeholder`);
      if (APPLY) {
        await db.certificate.update({ where: { id: existing.id }, data: { logo: placeholderSvg(name) } });
      }
    } else {
      console.log(`${name}: row exists with artwork — left untouched`);
    }
  }
  if (!APPLY) console.log("\nDry run — re-run with --apply to write.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

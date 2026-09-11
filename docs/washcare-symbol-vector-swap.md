# Wash-care symbols → swap to the delivered set

Grounding for the ledger task *"Replace the wash care symbols with Dilip's set
(exact PNGs, no conversion)"*. Everything below was measured against the
delivered `Care_symbols_1.zip` and this repo — it is not a proposal sketch.

> ## DECISION (11-09-2026): use the EXACT delivered PNGs
>
> No tracing, no vectorisation, no re-cutting. Artwork fidelity to the supplied
> files wins over vector output. **The "trace to SVG" plan below is superseded**
> — it is kept only because the measurements behind it (sizing, artboard
> geometry, the filename→code map) still apply.
>
> **PNG is fine at these sizes.** The symbols print into a 4.5 mm box, and the
> files are 843 px wide — an effective **4,758 DPI** (3,569 DPI in the 6 mm
> Output Builder box). Print line-art target is ~1200 DPI.
>
> **No code changes are needed.** The renderer already embeds PNG data URLs
> untouched (`src/lib/pdf/washcare-symbols.ts:103-110`) and the admin UI already
> accepts PNG (`wash-symbol-list.tsx:394-406`).
>
> ⚠️ **Do NOT add a raster-blocking guardrail** on the upload path — it would
> reject exactly the files we want.

## The requirement

Swap the whole wash-care symbol catalogue to the supplied set, using the exact
delivered files.

## What was delivered

64 PNGs, `843×596`, 8-bit RGB, **no alpha**, black-on-white, interlaced.
Filenames are the Monday dropdown phrases verbatim, with `℃` / `℉` escaped as
`#U2103` / `#U2109`.

## The renderer is already vector-safe — do not change it

Verified empirically through the same Blink/Skia print path the app uses
(`src/lib/pdf/renderer.ts:69`, `page.pdf()`), by dissecting the resulting PDF
operators:

| embed | PDF result |
|---|---|
| `<img src="data:image/svg+xml;base64,…">` | **vector** — `m`/`l`/`c`/`S`/`f` paths |
| inline `<svg>` | **vector** — identical operator profile |
| `<img src="data:image/png;base64,…">` | **raster** — one image XObject, single `Do` |

Chromium keeps SVG-in-`<img>` as vector through print-to-PDF. All eight symbol
emit sites already use that form and must be left alone:

- `src/lib/output-layouts/render.ts:598, :716, :741`
- `src/lib/pdf/templates/care-label-02.ts:294, :375`
- `src/lib/pdf/templates/families/spec-generic.ts:376, :530`
- `src/lib/pdf/templates/families/care-label-square-3label.ts:358`
- `src/lib/pdf/templates/netto-dk-privatelabel/info-area.ts:97`

> **"Stay vector" reduces entirely to: put SVG markup in `WashSymbol.svg`,
> never a PNG data URL.** `src/lib/pdf/washcare-symbols.ts:103-110` already
> base64-wraps raw SVG and passes data URLs through untouched.

The one way this silently regresses: `/settings/washcare-symbols` accepts
PNG/JPG and stores a raster data URL
(`src/app/(admin)/settings/washcare-symbols/wash-symbol-list.tsx:394-396`,
`accept=` at `:653`). Guard that.

## Codes are stable — no id remap

Care-label text visibility keys on the symbol **`code`**, verbatim
(`src/lib/care-labels/visibility.ts`; `CareLabel.showIfSymbols` /
`hideIfSymbols`, `prisma/schema.prisma:1894`), plus `action` + `restrictive` on
the row. Because 58 of the 64 filenames map onto codes that already exist in
`scripts/seed-washsymbol-monday-values.ts`, replacing only the `svg` column
leaves every care-text suppression rule untouched.

- **58** map onto existing codes (55 exact, 3 via alias)
- **6** have no code — the Fahrenheit set
- **1** existing code has no artwork — `wash90` ("Wash at or below 90℃")

Three need an explicit alias. Do **not** fuzzy-match at runtime:

| PNG filename | code | why |
|---|---|---|
| `Any Solvent except Trichloroethylene- Delicate` | `dryclean_no_trichloroethylene_delicate` | catalogue uses a **comma**; that comma is what `rejoinWashTokens` exists to handle — keep it in `mondayValue` |
| `Any Solvent except Trichloroethylene- Very Delicate` | `dryclean_no_trichloroethylene_very_delicate` | same |
| `Iron, High  Temperature` | `iron_high` | filename has a comma + double space |

## Sizing — still a live risk

> With PNGs there is no viewBox to re-cut, so if the size reads wrong the lever
> is **CSS** (box size or aspect), not the assets. The 800×800 recommendation
> below is superseded; the measurements are not.

Symbols render into a **square** box with `object-fit: contain`: 4.5 mm on the
care-label templates (`care-label-02.ts:172`, `spec-generic.ts:277`,
`care-label-square-3label.ts:218`) and `var(--ol-sym, 6mm)` in Output Builder
(`render.ts:1489`).

The supplied artboard is **landscape 1.41:1**, so dropped in as-is a glyph fills
only **47 % of the box height** (median 2.11 mm inside a 4.5 mm box).

Every glyph's ink bounding box was measured. The set is **internally
consistent** — margins match within each family (all tubs 675–676 px wide, all
triangles 422, all circles 393) — and the "Do not …" variants are legitimately
larger because the prohibition X overhangs the base pictogram. That relative
sizing is the ISO 3758 relationship: **do not trim each symbol to its own
bounding box.**

**Recommendation, verified against all 64:** re-cut every traced SVG to a common
**800×800 viewBox centred on the 843×596 artboard** — crop 21.5 px each side
horizontally, pad 102 px top and bottom.

- fits every glyph with 5 px to spare (tightest: `Do Not Wash`, 790 px ink)
- preserves the inter-symbol proportions
- lifts the median glyph to **61 % of the box** (2.76 mm long edge at 4.5 mm)

Calibrate the final figure against a current proof before committing.

**One artboard defect:** `Dry Flat.png` sits 91 px low on its artboard (15 % of
canvas height) — the only one of the 64 off-centre by more than 1 %. Re-centre
it during conversion or it prints visibly dropped next to its neighbours.

## Work (superseded — see the ledger task for the current plan)

1. **Trace** — potrace + SVGO. Clean 1-bit geometry, traces well; no manual
   redraw needed. Neither tool is currently in the toolchain.
2. **Normalise** — common 800×800 centred viewBox, re-centre `Dry Flat`,
   per-symbol visual QA against the source at print size.
3. **Reseed** — extend `scripts/seed-washsymbol-monday-values.ts` (or add a
   sibling `seed-washsymbol-svgs.ts`) to read the SVG directory and write `svg`
   by code. It is already idempotent and reconciles `name` / `mondayValue`. Add
   the 6 ℉ codes with `action: WASHING`, `restrictive: false`.
4. **Guardrail** — warn or block raster upload for wash symbols, and add a
   regression test asserting a symbol-only render produces **zero** image
   XObjects.
5. **Re-proof** — **38 print specs across 13 customers and 16 layout families**
   declare `washCareSymbols`. Before/after proofs, then sign off the size
   calibration. Print specs are declarative field manifests; none need editing.

## Open questions

- **`wash90`** — no artwork in the drop. Leave it on the old symbol (one odd one
  out among 63 new), get the file, or deactivate it?
- **The 6 ℉ symbols** — do they exist in the Monday dropdown? If a style picks
  one, care lines gated on `showIfSymbols: ["wash40"]` will not fire for its ℉
  twin. Need the `mondayValue` strings, or skip them.
- **Provenance** — these are auto-traced approximations of a supplied raster. If
  a licensed GINETEX / ISO 3758 vector master exists, use it instead. At 4.5 mm
  the trace error is invisible, but the master is the better source of record.

## No alpha — the one defect the exact files carry

The PNGs are 8-bit **RGB on white, not transparent**. `src/lib/output-layouts/render.ts:1431`
defines an inverted block mode (`.ol-binvert`, black background) and `:941` allows a
per-block custom background. A symbol placed in one of those will print inside a
**white rectangle**. Harmless on the white labels the care-label templates use;
check whether any live Output Builder layout puts symbols on a dark or tinted block.

## Filename → code map

| PNG file | code | match | catalogue `mondayValue` |
|---|---|---|---|
| `Wash at or below 104#U2109.png` | `—` | **NEW** | — (new code needed) |
| `Wash at or below 122#U2109.png` | `—` | **NEW** | — (new code needed) |
| `Wash at or below 140#U2109.png` | `—` | **NEW** | — (new code needed) |
| `Wash at or below 158#U2109.png` | `—` | **NEW** | — (new code needed) |
| `Wash at or below 194#U2109.png` | `—` | **NEW** | — (new code needed) |
| `Wash at or below 80#U2109.png` | `—` | **NEW** | — (new code needed) |
| `Bleach.png` | `bleach` | exact | Bleach |
| `Chlorine Bleach.png` | `bleach_chlorine` | exact | Chlorine Bleach |
| `Do Not Bleach.png` | `bleach_no` | exact | Do Not Bleach |
| `Non-Chlorine Bleach.png` | `bleach_non_chlorine` | exact | Non-Chlorine Bleach |
| `Drip Dry.png` | `dry_drip` | exact | Drip Dry |
| `Drip Dry in Shade.png` | `dry_drip_shade` | exact | Drip Dry in Shade |
| `Dry Flat.png` | `dry_flat` | exact | Dry Flat |
| `Dry Flat in Shade.png` | `dry_flat_shade` | exact | Dry Flat in Shade |
| `Hang to Dry.png` | `dry_hang` | exact | Hang to Dry |
| `Line Dry .png` | `dry_line` | exact | Line Dry |
| `Natural Dry.png` | `dry_natural` | exact | Natural Dry |
| `Do Not Dry.png` | `dry_no` | exact | Do Not Dry |
| `Dry in Shade.png` | `dry_shade` | exact | Dry in Shade |
| `Dry Clean.png` | `dryclean` | exact | Dry Clean |
| `Dry Clean- Any Solvent.png` | `dryclean_any_solvent` | exact | Dry Clean- Any Solvent |
| `Dry Clean- Low Heat.png` | `dryclean_low_heat` | exact | Dry Clean- Low Heat |
| `Do Not Dry Clean.png` | `dryclean_no` | exact | Do Not Dry Clean |
| `Dry Clean- No Steam.png` | `dryclean_no_steam` | exact | Dry Clean- No Steam |
| `Any Solvent except Trichloroethylene.png` | `dryclean_no_trichloroethylene` | exact | Any Solvent except Trichloroethylene |
| `Any Solvent except Trichloroethylene- Delicate.png` | `dryclean_no_trichloroethylene_delicate` | **alias** | Any Solvent except Trichloroethylene, Delicate |
| `Any Solvent except Trichloroethylene- Very Delicate.png` | `dryclean_no_trichloroethylene_very_delicate` | **alias** | Any Solvent except Trichloroethylene, Very Delicate |
| `Dry Clean- Petroleum Only.png` | `dryclean_petroleum` | exact | Dry Clean- Petroleum Only |
| `Dry Clean- Petroleum- Delicate.png` | `dryclean_petroleum_delicate` | exact | Dry Clean- Petroleum- Delicate |
| `Dry Clean- Petroleum- Very Delicate.png` | `dryclean_petroleum_very_delicate` | exact | Dry Clean- Petroleum- Very Delicate |
| `Dry Clean- Reduced Moisture.png` | `dryclean_reduced_moisture` | exact | Dry Clean- Reduced Moisture |
| `Dry Clean- Short Cycle.png` | `dryclean_short_cycle` | exact | Dry Clean- Short Cycle |
| `Iron- Any Temperature.png` | `iron_any` | exact | Iron- Any Temperature |
| `Iron, High  Temperature.png` | `iron_high` | **alias** | Iron- High Temperature |
| `Iron- Low Temperature.png` | `iron_low` | exact | Iron- Low Temperature |
| `Iron- Medium Temperature.png` | `iron_medium` | exact | Iron- Medium Temperature |
| `Do Not Iron.png` | `iron_no` | exact | Do Not Iron |
| `Steam.png` | `steam` | exact | Steam |
| `Do Not Steam.png` | `steam_no` | exact | Do Not Steam |
| `Tumble Dry- Delicate.png` | `tumble_delicate` | exact | Tumble Dry- Delicate |
| `Tumble Dry- High.png` | `tumble_high` | exact | Tumble Dry- High |
| `Tumble Dry- Low.png` | `tumble_low` | exact | Tumble Dry- Low |
| `Tumble Dry- Medium.png` | `tumble_medium` | exact | Tumble Dry- Medium |
| `Do Not Tumble Dry.png` | `tumble_no` | exact | Do Not Tumble Dry |
| `Tumble Dry- No Heat.png` | `tumble_no_heat` | exact | Tumble Dry- No Heat |
| `Tumble Dry.png` | `tumble_normal` | exact | Tumble Dry |
| `Tumble Dry- Permanent Press.png` | `tumble_permanent_press` | exact | Tumble Dry- Permanent Press |
| `Wash at or below 30#U2103.png` | `wash30` | exact | Wash at or below 30℃ |
| `Wash at or below 40#U2103.png` | `wash40` | exact | Wash at or below 40℃ |
| `Wash at or below 50#U2103.png` | `wash50` | exact | Wash at or below 50℃ |
| `Wash at or below 60#U2103.png` | `wash60` | exact | Wash at or below 60℃ |
| `Wash at or below 70#U2103.png` | `wash70` | exact | Wash at or below 70℃ |
| `Wash at or below 95#U2103.png` | `wash95` | exact | Wash at or below 95℃ |
| `Machine Wash- Delicate.png` | `wash_delicate` | exact | Machine Wash- Delicate |
| `Hand Wash only.png` | `wash_hand` | exact | Hand Wash only |
| `Machine Wash.png` | `wash_machine` | exact | Machine Wash |
| `Do Not Wash.png` | `wash_no` | exact | Do Not Wash |
| `Machine Wash- Permanent Press.png` | `wash_permanent_press` | exact | Machine Wash- Permanent Press |
| `Wet Clean.png` | `wetclean` | exact | Wet Clean |
| `Wet Clean- Delicate.png` | `wetclean_delicate` | exact | Wet Clean- Delicate |
| `Do Not Wet Clean.png` | `wetclean_no` | exact | Do Not Wet Clean |
| `Wet Clean- Very Delicate.png` | `wetclean_very_delicate` | exact | Wet Clean- Very Delicate |
| `Wring.png` | `wring` | exact | Wring |
| `Do Not Wring.png` | `wring_no` | exact | Do Not Wring |

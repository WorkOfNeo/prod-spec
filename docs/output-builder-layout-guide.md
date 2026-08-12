# Output Builder — the "default best layout" guide

How to build a layout in the Output Builder (`/output-builder`) so it matches the
house style and prints cleanly the first time. This is the checklist we calibrate
every new layout against — keep it current.

## TL;DR — what must be set

- [ ] **Name**: `<CUSTOMER> - <Business Area> - <Doc>` — e.g. `COOP DK - License - Care Label`.
- [ ] **docType**: the real category — `CARE_LABEL`, `CARTON_MARKING`, `STICKER`, … A carton marking is **`CARTON_MARKING`**, never `STICKER` (even if you cloned a STICKER sibling).
- [ ] **Sizing copied from a sibling** — never invent grids/fonts; match the closest existing published layout (table below). First guesses run **too large**.
- [ ] **Bordered boxes have padding** (≥ 0.5 mm) — never flush. Nudge a single edge with per-side padding.
- [ ] **Every token resolves** on a real style (0 unresolved). Image tokens (`{{logo:…}}`, `{{cert:…}}`) need artwork in the library or they print a placeholder chip that blocks approval.
- [ ] **Languages**: all required langs present for `{{composition:xx}}`, `{{careInstructions:xx}}`, `{{madeIn:xx}}`.
- [ ] **Repeat/split**: per-size docs use `repeatBy: ean` + `splitBy: ean`; one-per-carton docs use `repeatBy: none`.
- [ ] **Guides**: sewing/fold lines where the label seams/folds (care labels: top sewing line ~5 mm); a **centre hole** where a hang tag is punched.
- [ ] **Scoped** to customer + business area, **proof rendered** and eyeballed vs the approved artwork, then **published**.

## The model

A layout's `definition` JSON is `{ pages: [...], settings: {...} }`:

- **Page** — own mm size, a placement **grid** (`gridCols × gridRows`), print guides (`sewingLines`, `foldLine`, `centerHole`, `margins`), an optional `omitWhenEmpty` (see "Conditional pages"), and **blocks**.
- **Block** — placed by a grid **rect** (`col/row/colSpan/rowSpan`); carries styling (`fontPt`, `bold`, `align`, `valign`, `invert` + `invertBg`/`invertText`, `border` + `pad`, `fitWidth`) and its text as **`lines: []`** containing `{{tokens}}`.
- **Settings** — `repeatBy`, `splitBy`, `fileName`, `cartonNumbering`, `multipleStyles`, `customLogoWidthPct`.

The `layout:<id>` key is what a ProdSpec's `outputs[]` points at; one stable string ties the spec (what to print) → the registry (how to render) → the JobAsset (what was produced).

## Sizing conventions (copy these — don't invent)

| Doc | Page (mm) | Grid | Key fonts / guides |
|---|---|---|---|
| Care-label **size tag** | 35 × 45 | **7 × 9** | header 8 pt · `{{size}}` **11 pt (not bold)** · `{{campaignWeek}}` 9 pt · `{{barcode:ean13}}` 7 pt · sew top 5 mm |
| Care-label **text page** (composition / care / origin) | 35 × 90 | 7 × 18 or 12 × 12 | multi-lang body 5–6.5 pt · `{{washSymbols}}` ~6.5 pt · sew top 5 mm |
| **Carton marking** | 100 × 75 | 20 × 15 | field labels 7–10 pt · `{{barcode:cartonEan}}` ~7–9 pt |
| **Info area** sticker | 50 × 50 | 12 × 12 or 25 × 25 | composition ~5–7 pt · barcode ~9 pt |

When unsure, open the closest existing layout in the DB and copy its grid + font sizes verbatim.

## Borders & padding

- Add a `border` (width + hex colour) to framed fields.
- **Padding is per-side** — `border.pad {topMm, rightMm, bottomMm, leftMm}`, edited with a **🔗 link / per-side** toggle (linked = one value for all sides). A new border defaults to **0.5 mm** so it's never flush.
- Legacy single `border.padMm` still works (read as the same pad on every side) and auto-migrates to `pad`.

## Emphasis: inverted boxes

Use `invert` for highlight fields — e.g. the carton customer-item-no and the `DK` country chip. A barcode inside an inverted block keeps a white chip so it stays scannable.

The colours are authorable per block:

- `invertBg` — the box colour, hex (`#000` or `#1a1a1a`).
- `invertText` — the text on it, hex.

Both are **optional and independent**: leave one out and that side falls back to the historic pair (`#000000` background, `#ffffff` text), so every inverted block authored before this stays black-and-white until someone changes it. In the builder they appear as a swatch + hex field under the Invert checkbox, each with a **reset** back to the default.

## Two-form size labels — cm or age

Kids' size runs often arrive with both forms in one label:

```
86-92 cm / 1½-2 år, 98-104 cm / 3-4 år, 110-116 cm / 5-6 år, 122-128 cm / 7-8 år
```

Which half prints is a per-output choice, made with an argument on `{{sizeRangeCoop}}`:

| Token | Prints |
|---|---|
| `{{sizeRangeCoop}}` | `86-92 cm / 1½-2 år - 98-104 cm / 3-4 år - …` (as authored) |
| `{{sizeRangeCoop:numeric}}` | `86-92 cm - 98-104 cm - …` |
| `{{sizeRangeCoop:year}}` | `1½-2 år - 3-4 år - …` |

Rules (`src/lib/output-layouts/size-form.ts`):

- **The split is by the age unit** — `år` / `aar` / `ar`, `mdr` / `måned(er)`, `year(s)` / `yr(s)`, `month(s)` / `mth(s)`, `jahr(e)` — never by the slash alone. A size that IS slash-written (`86/92`, `23/26`) is therefore never cut in half.
- **Either half may come first**; the measurement keeps its own slashes and spacing (`86 / 92 cm / 1½-2 år` → `86 / 92 cm`).
- **No age half ⇒ the label prints as authored** for every form, so a form is safe to set on a layout whose styles don't all carry both. Same "never blank a printed field" contract as the size-scoped text fields.
- **Sizes that narrow onto the same text collapse to one entry** (two ages sharing a measurement) — and the current repetition's size still enlarges that entry.
- Bare (no argument) is a byte-for-byte passthrough, so published layouts are untouched.

## Rounded corners

`page.cornerRadiusMm` is the corner radius of the die, in mm. Absent or `0` = square corners (every page authored before this).

It is the **page** that rounds, not a drawn guide: `.ol-page` already clips its content, so a full-bleed or inverted block running into a corner prints the same curve the cutter makes instead of a square of ink the die would slice through. The `@page` box stays rectangular — the sheet it prints on is. A `pageBorder` curves with it **concentrically**, tightening by its own inset (`insetCornerRadiusMm`: radius 5 mm, inset 2 mm ⇒ a 3 mm frame corner; inset past the radius ⇒ square).

In the builder the canvas and the print preview both show the rounded sheet. The canvas *shows* the radius without clipping to it — clipping there would swallow a corner block's delete badge and make that block undeletable.

## Centre hole (die-cut hang hole)

`page.centerHole` marks the punch on a hang tag — `{ diameterMm, edge: "top" | "bottom", offsetMm }`. The hole is always centred across the page; `offsetMm` is measured from the named edge to the hole's **centre** (same convention as a sewing line's offset), so Ø 5 mm at offset 8 from the top leaves 5.5 mm of clear stock above it.

It's a **print guide**, like the sewing and fold lines: a dashed circle on the canvas and in the render, nothing knocked out of the design, no tokens, no grid cells, never a blocker for approval. Use it to keep content clear of what the punch removes.

## Tokens (cheat sheet)

- **Per language**: `{{composition:da}}`, `{{careInstructions:de}}`, `{{madeIn:en}}`, `{{country:xx}}`, `{{manufacturer:xx}}`.
- **Barcodes**: `{{barcode:ean13}}` (size EAN), `{{barcode:cartonEan}}` (carton EAN).
- **Symbols / logos / certs**: `{{washSymbols}}`, `{{logo:contrastAddress}}` / `{{logo:custom}}`, `{{cert:oekotex}}` / `{{cert:fsc}}`.
- **Pictures**: `{{image:<name>}}` — any number per output, from the shared library (see below).
- **Order / size**: `{{size}}` (the current row inside a repeat), `{{sizes}}`, `{{poNumber}}`, `{{orderNo}}` (FOB → customer order, else PO), `{{qtyPerCarton}}`, `{{lot}}`, `{{customerItemNo}}`, `{{customerOrderNo}}`, `{{description}}`, `{{campaignWeek}}`.
- **Size range (Coop)**: `{{sizeRangeCoop}}` — the whole run joined " - " with the current row's size enlarged; `:numeric` / `:year` pick one half of a two-form label (see below).
- **Conditionals**: `{{if deliveryTerm == FOB}}…{{else}}…{{endif}}` (one line, text tokens only) — see "Conditional text" below for the three operators.
- **Calculated**: `{{= sum(qtyPerCarton) }}` — arithmetic over field values; see "Calculated fields" below.

## Pictures — the image library vs the custom logo

Two ways to put artwork on a layout, and the difference is how many:

| | `{{logo:custom}}` | `{{image:<name>}}` |
|---|---|---|
| How many per layout | exactly one | as many as you like |
| Where it lives | on the layout row (`OutputLayout.customLogo`) | shared library, *Settings → Images* |
| Reused across layouts | no — re-uploaded per layout | yes — one row, every layout that places it |
| Sizing | `customLogoWidthPct` (one setting per layout) | per token: `{{image:x:40}}` |

New artwork belongs in the library. `{{logo:custom}}` still works exactly as it
did — it just can't be the answer when an output needs a *second* picture,
which is the whole reason the library exists.

**Sizing.** Bare (`{{image:coop-hanger}}`) prints at the block's font-derived
height, like a cert mark, so it drops onto a text line without thought. With a
percentage (`{{image:coop-hanger:40}}`) the *width* becomes 40% of the block and
the height follows the aspect ratio. The width rides on the token rather than a
layout setting because one layout now carries several pictures at different
sizes.

**Names are the contract.** The slug in the token is the only link between a
layout and its artwork — there's no foreign key, because the reference lives
inside the layout's JSON. So renaming or deleting a library row that layouts
still place is refused unless you confirm; the settings page lists which layouts
would break. Deactivating a row is *not* a soft option: a disabled picture
prints the same placeholder a missing one does.

**Validation is by shape, not by list.** Any well-formed slug publishes, even
one nobody has uploaded yet — that's a data gap, not an authoring error. It
renders the standard `missing` chip, which blocks approval, so the gap surfaces
on the proof rather than shipping as a blank.

## Conditional text — which operator to reach for

One condition per line, no nesting, and the field must be a text token:

| Operator | Test | Use it when |
|---|---|---|
| `==` / `!=` | the WHOLE field, trimmed + case-insensitive | the column holds exactly one of a few known values — `{{if deliveryTerm == FOB}}` |
| `contains` / `!contains` | substring, case-insensitive | the column *mentions* a word inside a messier value — `{{if productGroup contains Set}}` |
| `includes` / `!includes` | membership of a comma-separated list, per item, punctuation-insensitive (`OEKO-TEX` ≡ `OEKOTEX`) | the column is a list — `{{if certificates includes FSC}}` |

`contains` mirrors the generation-rules engine's `contains` (`src/lib/outputs/exclusion.ts`), so "does this field mention X" means the same thing in a rule and in a line.

**Worked example — a price label that knows a set from a single piece.** The
customer's spec: *"If the Product Group on Monday is 'Set', the price label
should display PER SÆT. Otherwise KR. for individual pieces."* That's one line
in the block:

```
{{price}} {{if productGroup contains Set}}PER SÆT{{else}}KR.{{endif}}
```

`contains` rather than `==` because the column isn't always the bare word —
`Set`, `Gift Set` and `SET 2-PACK` all print **PER SÆT**, while `3-Pack Socks`
prints **KR.**. Use `==` instead when the column really is exactly `Set` and a
`Sunset`-style false positive would matter. The Logic palette inserts this exact
line from the `{{if … contains …}}` chip.

## Calculated fields

`{{= expression }}` computes a number from field values, evaluated after
conditionals and before plain tokens (so a calc inside an `{{if}}` branch only
runs when that branch is taken). One line, like conditionals.

- **Arithmetic**: `+ - * /`, parentheses, numeric literals — `{{= qtyPerCarton * 2 }}`.
- **Aggregates across the styles on the carton**: `sum(field)`, `count(field)`,
  `min(field)`, `max(field)` — the base style plus the siblings picked in the
  carton dialog (standard generation = base only, same gate as `{{style2}}`).
  `{{= sum(qtyPerCarton) }}` is the canonical carton **Total**: one style → its
  own qty; a multi-style print → all of them summed. Aggregate fields are the
  sibling-projected ones (qtyPerCarton, styleNumber, description, …).
- **Rounding**: `round(expr, decimals)` (0–6, default 0). Integers print bare,
  fractions trimmed.
- **Missing styles never break the equation**: a direct sibling reference
  (`{{= qtyPerCarton + style2QtyPerCarton }}`) counts as 0 when the slot is
  empty; aggregates skip empty slots. Only a missing **base** value (e.g. no
  carton qty mapped) makes the calc unresolved — amber chip in preview, empty
  in production, and it gates readiness through the same columns the bare
  token would (`qtyPerCarton` → cartonQty).
- Bad syntax / unknown fields are **publish blockers** (and red chips on the
  canvas), like malformed conditionals.

## Conditional pages ("skip page when empty")

A page can carry content that only some styles have — the classic one is a page
whose whole job is the OEKO-TEX mark. `{{cert:oekotex}}` prints **only** on a
style that declares the cert, so on every other style that page came out as a
blank sheet in the middle of the set.

Tick **Skip page when empty** in *Page settings* (schema: `page.omitWhenEmpty`)
and that page is left out of the printed PDF whenever nothing on it resolves for
the style. A 3-page care label whose last page is only the mark prints as 2 pages
for a style without OEKO-TEX, and 3 for one with it.

- **Opt-in per page.** Off by default, so a deliberately blank page (a plain back
  side) keeps printing exactly as authored.
- **What counts as content**: anything a block actually prints — resolved tokens,
  literal wording, barcodes, symbols, placeholder chips. Chrome does **not**:
  block borders, the page border, sewing/fold guides. So `Certified
  {{cert:oekotex}}` keeps the page (the word "Certified" prints), while a bordered
  box holding only the mark doesn't.
- **Decided per repetition row**, so a `repeatBy: ean` layout can drop the page
  from one size's file and keep it in another's.
- **Preview always shows the page** — it has to stay editable; the gated mark
  shows its amber "not on style" chip there. Use *Open PDF* to see the real
  page count.
- A layout never renders to zero pages: if *every* page would drop, none does.

## Repeat & split

- `repeatBy: "ean"` + `splitBy: "ean"` → one PDF per size/EAN; `{{size}}` / `{{barcode:ean13}}` bind to that row. Use for care-label sets — the universal pages repeat into each size's file.
- `repeatBy: "none"` → one document. Use for carton markings.

## Generation rules (which styles get this output)

Set in the layout's **Settings** tab; stored on the def as
`settings.rules: [{ mode, field, op, keywords }]` and surfaced to the runner as
`TemplateVariant.generationRules`.

- `mode: "include"` → **generate ONLY when** a rule matches. Several include
  rules are alternatives (any one is enough).
- `mode: "exclude"` (the default) → **never generate when** it matches. An
  exclude match always wins over a satisfied include.
- `field` is a synced `ColumnMapping` key (`productGroup`, `targetGroup`, …),
  `op` is `contains` (substring) or `equals` (whole field), keywords are
  case-insensitive.
- A field that resolves to nothing matches nothing — so an include-only output
  stays un-generated until that field is synced.

Example — a barcode sticker only for shoes:

```json
{ "mode": "include", "field": "productGroup", "op": "contains", "keywords": ["shoes"] }
```

The same rules can be set for a whole document type in *Output Builder →
Document types* (`DocTypeDef.exclusionRules`); both gates must pass. Either way
the runner skips the output, logs why, and the style/review screens show the
reason instead of an "awaiting data" that never clears. Engine + shape:
`src/lib/outputs/exclusion.ts`.

## Verify before publish

Render a sample-data proof the same way the app does, then read the PDF:

1. `buildSampleStyleData()` — or a real `styleId` via `loadStyleRenderContext`.
2. `augmentCompositionTranslations` + `augmentTranslatedFields` for the langs the def uses.
3. `renderLayoutHtml(def, style, { mode: "production" })` → `renderPdf`.
4. Confirm 0 unresolved tokens, then compare against the approved artwork.

(Or just use the live preview in `/output-builder` — it shares the same render path.)

## Gotchas

- **Don't clobber hand-edits.** After a layout is edited in the builder, do not re-run a create/upsert script — it overwrites the whole `definition` and wipes the edits. Read current DB state and make targeted updates.
- **Placeholders.** `{{cert:…}}` / `{{logo:custom}}` / `{{image:…}}` print a placeholder until the artwork is uploaded (Settings → Certificates / the layout's logo / Settings → Images); a placeholder is a print-unsafe block that blocks approval.
- **New schema fields need a deploy.** Editing a layout to use a brand-new field (e.g. per-side `pad`) only renders correctly once the matching app version is deployed. Keep the legacy field as a fallback during the gap, or wait until it's live.

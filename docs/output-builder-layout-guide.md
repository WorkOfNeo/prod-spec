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
- [ ] **Repeat/split**: per-size docs use `repeatBy: ean` + `splitBy: ean`; one-per-carton docs use `repeatBy: none`. A care label for a two-quality pack adds `splitByComposition` + `{{compositionColour}}` in the file name.
- [ ] **Guides**: sewing/fold lines where the label seams/folds (care labels: top sewing line ~5 mm); a **centre hole** where a hang tag is punched.
- [ ] **Scoped** to customer + business area, **proof rendered** and eyeballed vs the approved artwork, then **published**.

## The model

A layout's `definition` JSON is `{ pages: [...], settings: {...} }`:

- **Page** — own mm size, a placement **grid** (`gridCols × gridRows`), print guides (`sewingLines`, `foldLine`, `centerHole`, `margins`), an optional `omitWhenEmpty` (see "Conditional pages"), and **blocks**.
- **Block** — placed by a grid **rect** (`col/row/colSpan/rowSpan`); carries styling (`fontPt`, `bold`, `align`, `valign`, `invert` + `invertBg`/`invertText`, `border` + `pad`, `fitWidth`) and its text as **`lines: []`** containing `{{tokens}}`.
- **Settings** — `repeatBy`, `splitBy`, `splitByComposition`, `fileName`, `cartonNumbering`, `multipleStyles`, `customLogoWidthPct`.

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
- **Sides are pickable** — `border.sides {top, right, bottom, left}`, four toggles under the width/colour row. A rule under one field, an L, a rule down one side: untick the edges you don't want. The last remaining edge can't be turned off — remove the border itself (width → **None**) instead.
- **Absent `sides` means all four.** Every border authored before this — i.e. every border in the DB — keeps printing all round and emits the same `border:` shorthand it always did; only a partial set switches to per-edge rules. Resolve it through `effectiveBorderSides()`, never by reading `sides` directly.
- Dropping a **vertical** rule gives its width back to the content: the block is `box-sizing: border-box`, so a fixed-size barcode inside a top-and-bottom-only border gets the full cell width.
- **Padding is per-side** — `border.pad {topMm, rightMm, bottomMm, leftMm}`, edited with a **🔗 link / per-side** toggle (linked = one value for all sides). A new border defaults to **0.5 mm** so it's never flush. Padding is independent of sides: it still insets the text on an edge with no rule.
- Legacy single `border.padMm` still works (read as the same pad on every side) and auto-migrates to `pad`.

The **page frame** (`page.pageBorder`) takes the same `sides` object, with the same absent-means-all-four rule — so a carton marking can carry a single rule along one edge instead of a box. A partial frame still curves concentrically with a rounded die; the edges you dropped simply aren't drawn.

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

Which half prints is a per-output choice, made with an argument on `{{sizeRangeCoop}}` (the whole run) or `{{size}}` (the current row's one size):

| Token | Prints |
|---|---|
| `{{sizeRangeCoop}}` | `86-92 cm / 1½-2 år - 98-104 cm / 3-4 år - …` (as authored) |
| `{{sizeRangeCoop:numeric}}` | `86/92-98/104-110/116-122/128 cm` |
| `{{sizeRangeCoop:year}}` | `1½/2-3/4-5/6-7/8 år` |
| `{{size}}` | `98-104 cm / 3-4 år` (as authored) |
| `{{size:numeric}}` | `98/104 cm` |
| `{{size:year}}` | `3/4 år` |

A form doesn't just pick a half — it prints as **one set**: the pair inside a single size is slash-joined and the unit is printed once, after the value(s). On `{{sizeRangeCoop}}` this also joins the sizes with `-`, so two delimiters do two jobs — `98/104-110/116` reads as two sizes where `98-104-110-116` would read as four. The input in Monday is unchanged; this is purely how it's recomputed for print.

Rules (`src/lib/output-layouts/size-form.ts`):

- **The split is by the age unit** — `år` / `aar` / `ar`, `mdr` / `måned(er)`, `year(s)` / `yr(s)`, `month(s)` / `mth(s)`, `jahr(e)` — never by the slash alone. A size that IS slash-written (`86/92`, `23/26`) is therefore never cut in half.
- **Either half may come first**; however the pair was written — `98-104`, `98 / 104`, `98–104` — it prints one way.
- **The unit is hoisted only when the run agrees on one.** A size that arrived without a unit doesn't cost the run its trailing `cm`; a run that genuinely mixes units (months *and* years in one column) keeps each unit inline instead, because a single trailing one would be a lie.
- **No age half ⇒ the label still prints** for every form (compacted, but never blank), so a form is safe to set on a layout whose styles don't all carry both. Same "never blank a printed field" contract as the size-scoped text fields.
- **Sizes that narrow onto the same text collapse to one entry** (two ages sharing a measurement) — and the current repetition's size still enlarges that entry. The shared unit sits *outside* the enlarged span: it belongs to the run, not to the size being called out.
- **A half carrying two units** (`1½-2 år / 18-24 mdr`) is left exactly as authored — better odd than mangled.
- Bare (no argument) is a byte-for-byte passthrough joined `" - "`, so layouts using the plain token are untouched.

## One PO, two packings — solid and assort

A PO that ships the same styles in BOTH solid (one size per carton) and
assortment (mixed) packing needs **two of some documents**: Tokmanni's 63368 /
63369 want two care labels per size, one naming the solid customer order
number and one the assort.

The order number arrives as ONE cell holding both:

```
Assort - 4530763 / Solid - 4530769
```

### `{{customerOrderNo:solid}}` / `:assort`

Narrows that cell to one number — the same split `{{qtyPerCarton:solid}}`
reads (`src/lib/output-layouts/carton-qty.ts`, one parser for both).

| Value in the column | `{{customerOrderNo}}` | `:solid` | `:assort` |
|---|---|---|---|
| `Assort - 4530763 / Solid - 4530769` | the whole cell | `4530769` | `4530763` |
| `4530769` (single packing) | `4530769` | `4530769` | `4530769` |
| `Assort - 4530763` | as authored | *(empty — amber chip)* | `4530763` |

A value with **no marker is handed back untouched**, so a layout carrying the
argument still prints correctly on a single-packing PO. A split that carries
the *other* packing but not this one resolves **empty** rather than silently
printing the wrong order number — a real gap, and it shows as an amber chip.

`:inner` / `:outer` are deliberately **not** accepted here: an order number has
no box level, so `{{customerOrderNo:outer}}` is a publish blocker rather than a
field that prints blank in production.

### Splitting the documents — three rules, not two

The layouts split on the same column, through **generation rules** (Settings →
the layout's rules). "Customer order no." and "PO number" are now offered as
rule fields alongside Product group.

| Layout | Rule | `fileName` |
|---|---|---|
| the ORIGINAL care label | **Never when** Customer order no. contains `assort` | unchanged |
| new — solid | **Only when** Customer order no. contains `solid` | `…-SOLID-{{size}}` |
| new — assort | **Only when** Customer order no. contains `assort` | `…-ASSORT-{{size}}` |

- **dual-packing PO** → original excluded, two new ones generate = **2 labels per size** ✓
- **normal PO** → bare number matches neither include rule, original generates = **1 label per size** ✓

**The exclude rule on the original is not optional.** Without it a dual PO
prints three labels per size. And the two new layouts must be *include* rules,
not excludes — a bare single-packing number matches neither, which is exactly
what keeps them off normal orders.

## Size lists — comma or dash

`{{sizes}}` and `{{sizeRange}}` join `S, M, L, XL, 2XL, 3XL`. Some stickers
specify the dash form instead:

| Token | Prints |
|---|---|
| `{{sizeRange}}` | `S, M, L, XL, 2XL, 3XL` |
| `{{sizeRange:dash}}` | `S-M-L-XL-2XL-3XL` |
| `{{sizes:dash}}` | the row's list, dash-joined |

Bare is unchanged, so no existing layout moves. A size whose own label carries
a slash (`86/92`) is never touched — only the join between sizes changes.

Don't reach for `{{sizeRangeCoop:numeric}}` to get dashes: that token also
prints the current repetition's size at **1.6× and bold** (it exists for Coop's
price tag), which is wrong on a plain "sizes available" line.

## Rounded corners

`page.cornerRadiusMm` is the corner radius of the die, in mm. Absent or `0` = square corners (every page authored before this).

It is the **page** that rounds, not a drawn guide: `.ol-page` already clips its content, so a full-bleed or inverted block running into a corner prints the same curve the cutter makes instead of a square of ink the die would slice through. The `@page` box stays rectangular — the sheet it prints on is. A `pageBorder` curves with it **concentrically**, tightening by its own inset (`insetCornerRadiusMm`: radius 5 mm, inset 2 mm ⇒ a 3 mm frame corner; inset past the radius ⇒ square).

In the builder the canvas and the print preview both show the rounded sheet. The canvas *shows* the radius without clipping to it — clipping there would swallow a corner block's delete badge and make that block undeletable.

### The cut line

Clipping alone is invisible in print: the sheet Chromium prints is a **rectangle**, so a rounded page whose corners carry no full-bleed ink comes out square and the supplier has nothing to cut to. `page.cutLine` (default **on**, and only offered where there is a radius) traces the die in **red dashes** at the page edge — a print guide like the sewing/fold/hole lines: no tokens, no grid cells, never a blocker for approval.

Turn it off for artwork that already shows the curve — a full-bleed background, or a `pageBorder` flush to the edge. On a square page it never draws: there the cut *is* the paper edge.

## Centre hole (die-cut hang hole)

`page.centerHole` marks the punch on a hang tag — `{ diameterMm, edge: "top" | "bottom", offsetMm }`. The hole is always centred across the page; `offsetMm` is measured from the named edge to the hole's **centre** (same convention as a sewing line's offset), so Ø 5 mm at offset 8 from the top leaves 5.5 mm of clear stock above it.

It's a **print guide**, like the sewing and fold lines: a dashed circle on the canvas and in the render, nothing knocked out of the design, no tokens, no grid cells, never a blocker for approval. Use it to keep content clear of what the punch removes.

## Tokens (cheat sheet)

- **Per language**: `{{composition:da}}`, `{{careInstructions:de}}`, `{{madeIn:en}}`, `{{country:xx}}`, `{{manufacturer:xx}}`.
- **Barcodes**: `{{barcode:ean13}}` (size EAN), `{{barcode:cartonEan}}` (carton EAN).
- **Symbols / logos / certs**: `{{washSymbols}}`, `{{logo:contrastAddress}}` / `{{logo:custom}}`, `{{cert:oekotex}}` / `{{cert:fsc}}`.
- **Pictures**: `{{image:<name>}}` — any number per output, from the shared library (see below).
- **Order / size**: `{{size}}` (the current row inside a repeat; `:numeric` / `:year` pick one half of a two-form label, see below), `{{sizes}}` / `{{sizeRange}}` (`:dash` joins `S-M-L-XL`, see below), `{{poNumber}}`, `{{orderNo}}` (FOB → customer order, else PO), `{{qtyPerCarton}}`, `{{lot}}`, `{{customerItemNo}}`, `{{customerOrderNo}}` (`:solid` / `:assort` — see below), `{{description}}`, `{{campaignWeek}}`.
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
- `repeatBy: "cartonEan"` → one PDF per per-size carton, **plus** a final assortment-master row. `"cartonEanSizeOnly"` is the same without that last row — for markings that only ever ship in solid cartons.
- `repeatBy: "assort"` → one PDF for the mixed master carton.

**Two carton markings for a dual-packing PO** is exactly this pair: a *solid*
marking on `cartonEanSizeOnly` (one PDF per size) and an *assort* marking on
`assort` (one PDF for the mixed case). Two layouts, not one — the repeat mode
is what differs, and a layout has one.

### "ean" is one repetition per size × colour

A PO that ships the same size in both packings carries that size **twice** in
its EAN rows, with the same product barcode. Those are one repetition, not two:
rows agreeing on size, product EAN and colour collapse, and the row carrying a
carton EAN wins so nothing loses a carton barcode.

Before this, every per-EAN output shipped two byte-identical files per size,
told apart only by the `-2` suffix `splitFilePlan` appends to a name collision
(Tokmanni's "two price stickers per size, both the same barcode"). Rows that
genuinely differ — a second colourway, a different EAN — still repeat
separately. A layout that wants one file per **carton** wants `repeatBy:
"cartonEan"`, which dedupes on the carton EAN instead.

### "splitByComposition" is a SECOND axis — one document per colour

Some packs ship two garments of different quality under one order, and the
buyer states both compositions in one field:

    Pink: 95% Cotton 5% Elastane, Grey melange: 57% Cotton 38% Polyester 5% Elastane

Each quality needs its own care label to approve. `splitByComposition: true`
adds a repetition axis on top of whatever `repeatBy` produced, so a per-EAN
care label ships **size × colour** files — a 4-size pack becomes 8 PDFs. Each
document prints only its own fibres; the colour lands on
`{{compositionColour}}`, which is what tells the two file names apart (add it
to `fileName`, or the split rows collide and fall back to the `-2` suffix).

**It cannot fire by accident.** The same `<label>: <fibres>` syntax far more
often means two parts of ONE garment (`Top: …, Bottom: …`, `Upper: …, Sole: …`,
`Outer: …, Lining: …`) — those must stay one label. Neither the colon nor the
separator distinguishes the two; what does is the label itself. The split runs
only when **every** part is labelled with a colour that style actually declares
— in its name's parentheses, its board colour, or its PO variant labels. A
survey of all live styles found 107 multi-label compositions: this rule split
the 13 genuine two-quality packs and left the other 94 alone. One unmatched
label disqualifies the whole string, so a style whose composition names colours
it doesn't carry keeps its single document until the data is fixed.

**Colour aliases.** The same colour is routinely written two ways — the
abbreviation in the style name (`LGM`) and the spelt-out colour in the
composition (`Grey melange`) — and exact matching rejects that pair. Declare
such spellings as one colour under **Settings › Colour aliases**
(`AppSetting: outputColourAliases`, loaded onto `StyleData.colourAliases` in
`buildStyleData`). An alias only ever WIDENS a style's own colours; it can't
make a garment-part composition split, and with no groups configured matching
stays exact.

**`{{compositionColour}}` falls back** to the row's colour name when nothing
split, so one file-name expression serves a layout whose styles don't all
split. Without the fallback an unsplit style resolves it empty — a stranded
`--` in the file name, and on the label itself a `missing` chip that blocks
approval.

Note this is independent of the *line* split: an un-split label already prints
one part per line (see `composition.ts`), and that stays true for garment-part
compositions.

## Generation rules (which styles get this output)

Set in the layout's **Settings** tab; stored on the def as
`settings.rules: [{ mode, field, op, keywords }]` and surfaced to the runner as
`TemplateVariant.generationRules`.

- `mode: "include"` → **generate ONLY when** a rule matches. Several include
  rules are alternatives (any one is enough).
- `mode: "exclude"` (the default) → **never generate when** it matches. An
  exclude match always wins over a satisfied include.
- `field` is a synced `ColumnMapping` key (`productGroup`, `targetGroup`,
  `customerOrderNo`, `poNumber`, …), `op` is `contains` (substring) or `equals`
  (whole field), keywords are case-insensitive.
- A field that resolves to nothing matches nothing — so an include-only output
  stays un-generated until that field is synced.

Example — a barcode sticker only for shoes:

```json
{ "mode": "include", "field": "productGroup", "op": "contains", "keywords": ["shoes", "boot", "sandal", "slipper", "sneaker", "clog"] }
```

**Keyword lists, not one word.** `contains` is a plain substring test, so
`"slippers"` does not contain `"shoes"` — a slipper style silently drops out of
a `["shoes"]`-only include rule and its barcode sticker never generates. Real
taxonomies are messy; list the words the column actually holds.

Gating on the **order number** rather than the product splits a dual-packing PO
into a solid document and an assort one — see "One PO, two packings" above.

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

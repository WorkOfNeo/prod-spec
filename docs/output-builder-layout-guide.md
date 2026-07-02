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
- [ ] **Guides**: sewing/fold lines where the label seams/folds (care labels: top sewing line ~5 mm).
- [ ] **Scoped** to customer + business area, **proof rendered** and eyeballed vs the approved artwork, then **published**.

## The model

A layout's `definition` JSON is `{ pages: [...], settings: {...} }`:

- **Page** — own mm size, a placement **grid** (`gridCols × gridRows`), print guides (`sewingLines`, `foldLine`, `margins`), and **blocks**.
- **Block** — placed by a grid **rect** (`col/row/colSpan/rowSpan`); carries styling (`fontPt`, `bold`, `align`, `valign`, `invert`, `border` + `pad`, `fitWidth`) and its text as **`lines: []`** containing `{{tokens}}`.
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

Use `invert` (white text on solid black) for highlight fields — e.g. the carton customer-item-no and the `DK` country chip. A barcode inside an inverted block keeps a white chip so it stays scannable.

## Tokens (cheat sheet)

- **Per language**: `{{composition:da}}`, `{{careInstructions:de}}`, `{{madeIn:en}}`, `{{country:xx}}`, `{{manufacturer:xx}}`.
- **Barcodes**: `{{barcode:ean13}}` (size EAN), `{{barcode:cartonEan}}` (carton EAN).
- **Symbols / logos / certs**: `{{washSymbols}}`, `{{logo:contrastAddress}}` / `{{logo:custom}}`, `{{cert:oekotex}}` / `{{cert:fsc}}`.
- **Order / size**: `{{size}}` (the current row inside a repeat), `{{sizes}}`, `{{poNumber}}`, `{{orderNo}}` (FOB → customer order, else PO), `{{qtyPerCarton}}`, `{{lot}}`, `{{customerItemNo}}`, `{{customerOrderNo}}`, `{{description}}`, `{{campaignWeek}}`.
- **Conditionals**: `{{if deliveryTerm == FOB}}…{{else}}…{{endif}}` (one line, text tokens only).
- **Calculated**: `{{= sum(qtyPerCarton) }}` — arithmetic over field values; see "Calculated fields" below.

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

## Repeat & split

- `repeatBy: "ean"` + `splitBy: "ean"` → one PDF per size/EAN; `{{size}}` / `{{barcode:ean13}}` bind to that row. Use for care-label sets — the universal pages repeat into each size's file.
- `repeatBy: "none"` → one document. Use for carton markings.

## Verify before publish

Render a sample-data proof the same way the app does, then read the PDF:

1. `buildSampleStyleData()` — or a real `styleId` via `loadStyleRenderContext`.
2. `augmentCompositionTranslations` + `augmentTranslatedFields` for the langs the def uses.
3. `renderLayoutHtml(def, style, { mode: "production" })` → `renderPdf`.
4. Confirm 0 unresolved tokens, then compare against the approved artwork.

(Or just use the live preview in `/output-builder` — it shares the same render path.)

## Gotchas

- **Don't clobber hand-edits.** After a layout is edited in the builder, do not re-run a create/upsert script — it overwrites the whole `definition` and wipes the edits. Read current DB state and make targeted updates.
- **Placeholders.** `{{cert:…}}` / `{{logo:custom}}` print a placeholder until the artwork is uploaded (Settings → Certificates / the layout's logo); a placeholder is a print-unsafe block that blocks approval.
- **New schema fields need a deploy.** Editing a layout to use a brand-new field (e.g. per-side `pad`) only renders correctly once the matching app version is deployed. Keep the legacy field as a fallback during the gap, or wait until it's live.

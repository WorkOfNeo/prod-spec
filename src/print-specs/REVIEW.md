# Print spec review — `dimensionsVerified: false`

51 of 84 specs need human follow-up before production use (brief acceptance criterion 5).
Grouped by reason — the first three groups are the genuinely actionable ones; the “by design” groups are listed for completeness because the brief flags every spec without a mm callout.

## Scanned or image-only sources (12)

Dimensions could not be machine-extracted. Measure physical samples / source artwork before production use.

| Spec | Source PDF | What to do |
|---|---|---|
| `coop-365/private-label/c-po62728-carelabel-16-05-2026.ts` | Coop 365-Private Label-C-PO62728 Carelabel 16.05.2026.pdf | Scanned folded label (callouts 25/10/50 mm). Verify fold layout and finished size manually (brief F4). |
| `coop-365/private-label/po62728-il97261-rev-banderole-2026-5-26.ts` | Coop 365-Private Label-PO62728  IL97261 REV Banderole 2026.5.26.pdf | Image-based banderole; no print-size callout. Measure artwork / confirm print size. |
| `coop-dk/accessories/c-po62728-carelabel-16-05-2026.ts` | Coop DK-Accessories-C-PO62728 Carelabel 16.05.2026.pdf | Scanned folded label (callouts 25/10/50 mm). Verify fold layout and finished size manually (brief F4). |
| `coop-dk/accessories/po62726-il97253-97255-97258-97254-97257-rev-hangtag-price-sticker-2026-5-22.ts` | Coop DK-Accessories-PO62726  IL97253-97255-97258-97254-97257 REV hangtag+Price sticker 2026.5.22.pdf | Image-based hangtag + price sticker; no print-size callout. Confirm print size. |
| `coop-dk/accessories/po62726-il97252-rev-banderole-2026-5-22.ts` | Coop DK-Accessories-PO62726-IL97252 - REV  Banderole -2026.5.22.pdf | Image-based banderole; no print-size callout. Confirm print size. |
| `europris/t2c/po62740-rev-hangtag-2026-4-21.ts` | Europris-T2C-PO62740 REV HANGTAG 2026.4.21.pdf | Scanned hangtag; no print-size callout. Also decide whether to promote to dynamic (9-language composition content). |
| `ottos-ag-zentrallager/license/washcare-label.ts` | Otto's AG Zentrallager-License-Washcare Label.pdf | Scanned A4; 35×90 placeholder from F1 family. Measure physical samples (brief F5). |
| `ottos-ag-zentrallager/private-label/washcare-label.ts` | Otto's AG Zentrallager-Private label-Washcare Label.pdf | Scanned A4; 35×90 placeholder from F1 family. Measure physical samples (brief F5). |
| `runsven/license/po63084-evc00130-carelabel.ts` | Runsven-License-PO63084  EVC00130 carelabel.pdf | Image-only PDF, zero extractable text — manual review required (brief special flag). Verify all fields and dimensions against sample. |
| `runsven/private-label/62951-banderole-layout.ts` | Runsven-Private Label-62951 - Banderole layout.pdf | No print-size callout (700×600 mm document page). Confirm banderole print size. |
| `sok/license/washcare-label.ts` | SOK-License-Washcare label.pdf | Scanned A4; 35×90 placeholder from F1 family. Measure physical samples (brief F5). |
| `sok/private-label/washcare-label.ts` | SOK-Private Label-Washcare label.pdf | Scanned A4; 35×90 placeholder from F1 family. Measure physical samples (brief F5). |

## OCR-garbled dimension callouts (1)

A callout exists but could not be read reliably. Verify the stated value.

| Spec | Source PDF | What to do |
|---|---|---|
| `europris/t2c/po62740-rev-carelabel-2026-4-21.ts` | Europris-T2C-PO62740 REV carelabel 2026.4.21.PDF | Callout OCR-garbled ('3.5X6.6cm'); 35×66 best estimate. Verify against physical label. |

## Field-marker templates without callouts (14)

Layout is a placeholder template. Dimensions in the spec are placeholders taken from a sibling/analog layout.

| Spec | Source PDF | What to do |
|---|---|---|
| `dollarstore/private-label/barcode-sticker.ts` | Dollarstore-Private label-Barcode sticker.pdf | Template without callouts; 35×24 placeholder from License price/barcode sticker. Verify size and language set. |
| `dollarstore/private-label/polybag-sticker.ts` | Dollarstore-Private label-POLYBAG STICKER.pdf | Template without callouts; 105×75 placeholder from License assortment sticker. Verify size and field set. |
| `dollarstore/private-label/washcare-label.ts` | Dollarstore-Private label-Washcare label.pdf | Template without callouts; 35×90 placeholder from F1 family. Verify size, sheet structure, languages and COO presence. |
| `europris/private-label/po62740-polybag-sticker-2026-5-13.ts` | Europris-Private label-PO62740  polybag sticker 2026.5.13.pdf | Template without callouts; 105×75 placeholder. Measure real polybag sticker size. |
| `europris/t2c/po62740-polybag-sticker-2026-5-13.ts` | Europris-T2C-PO62740  polybag sticker 2026.5.13.pdf | Template without callouts; 105×75 placeholder. Measure real polybag sticker size. |
| `kaufland/private-label/care-label.ts` | Kaufland-Private Label-Care label.pdf | Template without callouts; 155×40 placeholder from License sibling. Verify size, languages and care-instruction presence. |
| `kaufland/private-label/carton-marking.ts` | Kaufland-Private Label-Carton marking.pdf | Carton template without size callout (License sibling is 200×75). Confirm print size. |
| `ottos-ag-zentrallager/license/sticker-for-hangtag.ts` | Otto's AG Zentrallager-License-Sticker for Hangtag.pdf | Marker-only layout without callouts; 28×35 placeholder. Measure real sticker; confirm retail price currency (CHF not representable). |
| `ottos-ag-zentrallager/private-label/sticker-for-hangtag.ts` | Otto's AG Zentrallager-Private label-Sticker for Hangtag.pdf | Marker-only layout without callouts; 28×35 placeholder. Measure real sticker; confirm retail price currency (CHF not representable). |
| `tokmanni/license/price-sticker.ts` | Tokmanni-License-PRICE STICKER.pdf | Marker-only template without callouts; 28×35 placeholder. Measure real sticker size. |
| `tokmanni/license/washcare-label-layout-1.ts` | Tokmanni-License-WASHCARE LABEL LAYOUT (1).pdf | Template without callouts; 35×90 placeholder from F1 family. Verify size, sheet structure and FI/SV language assumption. |
| `tokmanni/private-label/polybag-sticker.ts` | Tokmanni-Private label-POLYBAG STICKER.pdf | Template without callouts; 60×50 placeholder from License sibling. Verify size and field set. |
| `tokmanni/private-label/price-sticker.ts` | Tokmanni-Private label-PRICE STICKER.pdf | Marker-only template without callouts; 28×35 placeholder. Measure real sticker size. |
| `tokmanni/private-label/washcare-label-layout-1.ts` | Tokmanni-Private label-WASHCARE LABEL LAYOUT (1).pdf | Template without callouts; 35×90 placeholder from F1 family. Verify size, sheet structure and FI/SV language assumption. |

## No callout — placeholder dimensions from an analog (3)

Dimensions in the spec are estimates from the closest comparable print. Measure the real print.

| Spec | Source PDF | What to do |
|---|---|---|
| `coop-dk/loved/62522-tag-sticker-layout.ts` | Coop DK-Loved-62522 - tag sticker layout.pdf | No mm callout; 35×60 placeholder from Coop price tag analog. Measure real sticker size. |
| `sok/license/price-sticker.ts` | SOK-License-Price sticker.pdf | No mm callout; 28×35 placeholder from Ge-kås analog. Measure real sticker size. |
| `sok/private-label/price-sticker.ts` | SOK-Private Label-Price sticker.pdf | No mm callout; 28×35 placeholder from Ge-kås analog. Measure real sticker size. |

## Dimensions drawn but not machine-extractable (1)

The PDF contains the sizes as drawings; record them manually if needed.

| Spec | Source PDF | What to do |
|---|---|---|
| `runsven/license/63084-updated-box-layouts-26-6-3.ts` | Runsven-License-63084 updated box layouts--26.6.3.pdf | Multiple box layouts; per-layout dimensions drawn in PDF, not machine-extractable. Record sizes from source PDF if needed. |

## Size per PO (by design) (13)

Carton/box markings whose print size follows each purchase order. Nothing to measure; confirm no fixed format is required.

| Spec | Source PDF | What to do |
|---|---|---|
| `coop-dk/license/62897-carton-marking-layout.ts` | Coop DK-License-62897 - carton marking layout.pdf | Carton marking size per PO — confirm no fixed format is required. |
| `coop-dk/loved/62897-carton-marking-layout.ts` | Coop DK-Loved-62897 - carton marking layout.pdf | Carton marking size per PO — confirm no fixed format is required. |
| `europris/private-label/62916-carton-marking-layout.ts` | Europris-Private label-62916 - carton marking layout.pdf | Carton size per PO (BOX SIZE W/L/H blank) — confirm no fixed format is required. |
| `europris/t2c/62916-carton-marking-layout.ts` | Europris-T2C-62916 - carton marking layout.pdf | Carton size per PO (BOX SIZE W/L/H blank) — confirm no fixed format is required. |
| `ge-kas-ullared/license/carton-marking-layout.ts` | Ge-kås Ullared-License-Carton marking layout.pdf | Carton marking size per PO — confirm no fixed format is required. |
| `ge-kas-ullared/private-label/carton-marking-layout.ts` | Ge-kås Ullared-Private label-Carton marking layout.pdf | Carton marking size per PO — confirm no fixed format is required. |
| `netto-dk/body-guide/carton-marking.ts` | Netto DK-Body Guide-Carton Marking.pdf | Box marking size per PO — confirm no fixed format is required. |
| `netto-dk/license/carton-marking.ts` | Netto DK-License-Carton marking.pdf | Box marking size per PO — confirm no fixed format is required. |
| `netto-dk/private-label/carton-marking.ts` | Netto DK-Private Label-Carton marking.pdf | Box marking size per PO — confirm no fixed format is required. |
| `ottos-ag-zentrallager/license/carton-marking.ts` | Otto's AG Zentrallager-License-Carton marking.pdf | Scanned, sparse carton layout; size per PO — confirm no fixed format is required. |
| `ottos-ag-zentrallager/private-label/carton-marking.ts` | Otto's AG Zentrallager-Private label-Carton marking.pdf | Scanned, sparse carton layout; size per PO — confirm no fixed format is required. |
| `rema-1000/license/carton-marking.ts` | Rema 1000-License-Carton marking.pdf | Box marking size per PO — confirm no fixed format is required. |
| `rema-1000/private-label/carton-marking.ts` | Rema 1000-Private Label-Carton marking.pdf | Box marking size per PO — confirm no fixed format is required. |

## Size-changeable by design (7)

Info areas / direct prints that scale with the packaging. Parts carry 0×0 dimensions on purpose.

| Spec | Source PDF | What to do |
|---|---|---|
| `netto-de/body-guide/info-areas-1.ts` | Netto DE-Body Guide-INFO AREAS 1.pdf | 'SIZE CHANGEABLE' — confirm the renderer takes dimensions from packaging; no fixed size to verify. |
| `netto-de/license/info-areas-1.ts` | Netto DE-License-INFO AREAS 1.pdf | 'SIZE CHANGEABLE' — confirm the renderer takes dimensions from packaging; no fixed size to verify. |
| `netto-de/private-label/info-areas-1.ts` | Netto DE-Private label-INFO AREAS 1.pdf | 'SIZE CHANGEABLE' — confirm the renderer takes dimensions from packaging; no fixed size to verify. |
| `netto-dk/license/info-area.ts` | Netto DK-License-Info Area.pdf | Direct print on packaging — confirm the renderer takes dimensions from packaging; no fixed size to verify. |
| `netto-dk/private-label/info-area.ts` | Netto DK-Private Label-Info Area.pdf | Direct print on packaging — confirm the renderer takes dimensions from packaging; no fixed size to verify. |
| `rema-1000/license/info-area.ts` | Rema 1000-License-Info Area.pdf | Direct print on packaging — confirm the renderer takes dimensions from packaging; no fixed size to verify. |
| `rema-1000/private-label/info-area.ts` | Rema 1000-Private Label-Info Area.pdf | Direct print on packaging — confirm the renderer takes dimensions from packaging; no fixed size to verify. |

---
Generated by the AGENT BRIEF run from `Renamed PDFs/` (84 PDFs). Totals: 54 dynamic / 30 static-pdf.

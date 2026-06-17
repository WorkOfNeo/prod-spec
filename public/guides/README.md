# Reviewer guides

These are the in-app reviewer guides, served at **`/guides`** inside the app
and also downloadable as PDFs. Each guide is a self-contained HTML file in this
folder; the matching `.pdf` is rendered from it.

## How it fits together

- **`*.html`** — one file per guide. The content + mockups. They link the shared
  stylesheet `_guide.css`.
- **`_guide.css`** — shared styling for every guide (colours, spacing, the mockup
  components). Tweak here to restyle all guides at once. It has an `@media screen`
  block for the in-app/browser reading view; the PDFs are unaffected (they render
  with print media via `@page`).
- **`*.pdf`** — rendered from each HTML with headless Chrome (Puppeteer).
- **`00-reviewer-handbook-all.pdf`** — all guides merged into one booklet.
- **Registry:** [`src/lib/guides.ts`](../../src/lib/guides.ts) — the list that
  drives the `/guides` index, the sidebar link, and each page's slug.
- **Pages:** `src/app/(admin)/guides/` — the index + the `[slug]` page that
  embeds the HTML in an auto-sizing iframe.

The `/guides` pages sit under the app's authenticated layout, so they're visible
to anyone signed in (reviewers and admins). The raw files in `public/` are served
statically and are not behind auth.

## Edit a guide

1. Edit the `*.html` file (or `_guide.css` for global styling).
2. Re-render its PDF:
   ```sh
   node scripts/render-guide.mjs public/guides/02-my-tasks.html public/guides/02-my-tasks.pdf
   ```
3. Rebuild the combined booklet (order matters):
   ```sh
   pdfunite public/guides/00-cover.pdf public/guides/01-getting-around.pdf \
     public/guides/02-my-tasks.pdf public/guides/03-reviews-queue.pdf \
     public/guides/04-finding-a-style.pdf public/guides/05-reviewing-outputs.pdf \
     public/guides/06-style-data.pdf public/guides/00-reviewer-handbook-all.pdf
   ```

The in-app view updates the moment you save the HTML (no PDF needed); the PDF
steps are only for the downloadable copies.

## Add a new guide

1. Create `public/guides/NN-your-guide.html`. Easiest start: copy an existing one
   and keep the `<link rel="stylesheet" href="_guide.css" />` in the `<head>`.
2. Render its PDF (see above) and add it to the `pdfunite` booklet command.
3. Add one entry to the `GUIDES` array in
   [`src/lib/guides.ts`](../../src/lib/guides.ts):
   ```ts
   { slug: "your-guide", file: "NN-your-guide.html", title: "Your guide", summary: "One line." }
   ```

That's it — the index card, sidebar reachability, and `/guides/your-guide` page
all come from that one entry.

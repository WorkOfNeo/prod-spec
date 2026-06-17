// Reviewer guides shown in-app under /guides.
//
// The guide content lives as self-contained HTML in `public/guides/` (served
// statically at `/guides/<file>`). To ADD a guide: drop an HTML file in
// public/guides/ (link `_guide.css` for the shared styling), render its PDF
// with `node scripts/render-guide.mjs public/guides/<file>.html public/guides/<file>.pdf`,
// then add one entry to GUIDES below. To EDIT one: change the HTML and re-render.

export type Guide = {
  /** URL segment: /guides/<slug> */
  slug: string;
  /** File in public/guides/ — served at /guides/<file>; PDF is the .pdf sibling. */
  file: string;
  title: string;
  summary: string;
};

export const GUIDES: Guide[] = [
  {
    slug: "overview",
    file: "00-cover.html",
    title: "Overview",
    summary: "Your role in a nutshell, how a style reaches you, and what's in the handbook.",
  },
  {
    slug: "getting-around",
    file: "01-getting-around.html",
    title: "Getting around",
    summary: "Your sidebar, the three places you'll use, and how to move around.",
  },
  {
    slug: "my-tasks",
    file: "02-my-tasks.html",
    title: "My tasks",
    summary: "Your personal to-do in four buckets, the X / Y progress, and how to start a review.",
  },
  {
    slug: "reviews-queue",
    file: "03-reviews-queue.html",
    title: "The Reviews queue",
    summary: "The shared list of everything awaiting review — and how it differs from My tasks.",
  },
  {
    slug: "finding-a-style",
    file: "04-finding-a-style.html",
    title: "Finding a style",
    summary: "The Styles list: search, filters, and the status & readiness columns.",
  },
  {
    slug: "reviewing-outputs",
    file: "05-reviewing-outputs.html",
    title: "Reviewing a style — the outputs",
    summary: "The Review screen: readiness, statuses, the document accordions, and Approve / Reject.",
  },
  {
    slug: "style-data",
    file: "06-style-data.html",
    title: "Reviewing a style — the data",
    summary: "Care instructions, required fields, EAN barcodes & the PO PDF, and the Monday link.",
  },
];

/** The combined booklet (all guides, one PDF). */
export const HANDBOOK_PDF = "/guides/00-reviewer-handbook-all.pdf";

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export function guideHref(g: Guide): string {
  return `/guides/${g.slug}`;
}

export function guideHtmlSrc(g: Guide): string {
  return `/guides/${g.file}`;
}

export function guidePdfSrc(g: Guide): string {
  return `/guides/${g.file.replace(/\.html$/, ".pdf")}`;
}

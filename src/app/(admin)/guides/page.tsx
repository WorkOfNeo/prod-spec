import Link from "next/link";
import { GUIDES, HANDBOOK_PDF, guideHref } from "@/lib/guides";

export const metadata = { title: "Guides" };

// Reviewer guides index. Content is static HTML in public/guides/ — see
// src/lib/guides.ts for how to add or edit a guide.
export default function GuidesIndexPage() {
  return (
    <div className="px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Guides</h1>
          <p className="text-sm text-zinc-500">
            Step-by-step reviewer guides. Open one to read it here, or download the full handbook.
          </p>
        </div>
        <a
          href={HANDBOOK_PDF}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Download handbook (PDF)
        </a>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {GUIDES.map((g, i) => (
          <Link
            key={g.slug}
            href={guideHref(g)}
            className="group rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs font-semibold text-zinc-400">
                {String(i).padStart(2, "0")}
              </span>
              <span className="text-sm font-semibold text-zinc-900 group-hover:text-zinc-700">
                {g.title}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{g.summary}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

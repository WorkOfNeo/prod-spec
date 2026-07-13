import Link from "next/link";
import { getSessionWithRole } from "@/lib/auth-server";
import { REVIEWER_GUIDES, ADMIN_GUIDES, HANDBOOK_PDF, guideHref, type Guide } from "@/lib/guides";

export const metadata = { title: "Guides · Prod Spec" };

function GuideCard({ guide, index }: { guide: Guide; index: number }) {
  return (
    <Link
      href={guideHref(guide)}
      className="group rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-semibold text-zinc-400">
          {String(index).padStart(2, "0")}
        </span>
        <span className="text-sm font-semibold text-zinc-900 group-hover:text-zinc-700">
          {guide.title}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{guide.summary}</p>
    </Link>
  );
}

// Guides index. Content is static HTML in public/guides/ — see
// src/lib/guides.ts for how to add or edit a guide. Reviewer guides are shown
// to everyone signed in; admin-only guides appear in their own section for
// ADMINs (and are gated server-side on the [slug] page).
export default async function GuidesIndexPage() {
  const { role } = await getSessionWithRole();
  const isAdmin = role === "ADMIN";

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
        {REVIEWER_GUIDES.map((g, i) => (
          <GuideCard key={g.slug} guide={g} index={i} />
        ))}
      </div>

      {isAdmin && ADMIN_GUIDES.length > 0 && (
        <div className="mt-10">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Admin</h2>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
              Admins only
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Reference for configuration only admins can change. Not shown to reviewers.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ADMIN_GUIDES.map((g, i) => (
              <GuideCard key={g.slug} guide={g} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { getGuide, guideHtmlSrc, guidePdfSrc } from "@/lib/guides";
import { GuideFrame } from "./guide-frame";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = getGuide(slug);
  return { title: guide?.title ?? "Guide" };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = getGuide(slug);
  if (!guide) notFound();

  // Admin-only guides bounce REVIEWERs to their dashboard, matching
  // requireAdminPage — hiding the index card is not access control.
  if (guide.adminOnly) {
    const { role } = await getSessionWithRole();
    if (role !== "ADMIN") redirect("/dashboard");
  }

  return (
    <div className="px-6 py-5">
      <Link href="/guides" className="text-xs text-muted hover:text-ink">
        ← All guides
      </Link>
      <div className="mt-1 flex items-start justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">{guide.title}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={guideHtmlSrc(guide)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            Open in new tab ↗
          </a>
          <a
            href={guidePdfSrc(guide)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download PDF
          </a>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
        <GuideFrame src={guideHtmlSrc(guide)} title={guide.title} />
      </div>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
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

  return (
    <div className="px-8 py-8">
      <Link href="/guides" className="text-xs text-zinc-500 hover:text-zinc-800">
        ← All guides
      </Link>
      <div className="mt-1 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{guide.title}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={guideHtmlSrc(guide)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Open in new tab ↗
          </a>
          <a
            href={guidePdfSrc(guide)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Download PDF
          </a>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <GuideFrame src={guideHtmlSrc(guide)} title={guide.title} />
      </div>
    </div>
  );
}

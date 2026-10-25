import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

// The top of a page: an optional way back, an 18px title, one quiet line of
// context, and the page's actions on the right. Anything under the title
// (a claim chip, a progress line) goes in children.

export function PageHeader({
  back,
  backSlot,
  title,
  meta,
  actions,
  children,
  className = "",
}: {
  back?: { href: string; label: string };
  // A back link that needs the browser (e.g. one that remembers the list's
  // filters) — rendered where `back` would be.
  backSlot?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div data-section="Page header" className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-3 ${className}`}>
      {/* Grows from 20rem, so a long description wraps under the title instead
          of pushing the actions onto their own line. */}
      <div className="min-w-0 flex-[1_1_20rem]">
        {back ? (
          <Link
            href={back.href}
            className="text-muted hover:text-ink -ml-1 mb-1 inline-flex items-center gap-0.5 rounded px-1 text-[12px]"
          >
            <ChevronLeft size={14} aria-hidden="true" />
            {back.label}
          </Link>
        ) : backSlot ? (
          <div className="mb-1">{backSlot}</div>
        ) : null}
        <h1 className="text-ink text-[18px] leading-7 font-semibold tracking-[-0.01em]">{title}</h1>
        {meta ? <div className="text-muted mt-0.5 text-[13px]">{meta}</div> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-start gap-2">{actions}</div> : null}
    </div>
  );
}

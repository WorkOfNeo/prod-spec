import type { ReactNode } from "react";

// A status pill: 20px, soft fill, the tone's own ink. Mono has no soft fills
// (they're all white), so the pill draws a hairline there instead.

export type PillTone = "neutral" | "good" | "bad" | "warn" | "accent";

const TONES: Record<PillTone, string> = {
  neutral: "bg-subtle text-muted",
  good: "bg-good-soft text-good",
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  accent: "bg-accent-soft text-accent-text",
};

const DOTS: Record<PillTone, string> = {
  neutral: "bg-faint",
  good: "bg-good",
  bad: "bg-bad",
  warn: "bg-warn",
  accent: "bg-accent",
};

export function Pill({
  tone = "neutral",
  dot = false,
  title,
  className = "",
  children,
}: {
  tone?: PillTone;
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`mono:border-line inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap mono:border ${TONES[tone]} ${className}`}
    >
      {dot ? <span aria-hidden="true" className={`size-1.5 rounded-full ${DOTS[tone]}`} /> : null}
      {children}
    </span>
  );
}

/** Just the dot, for dense lists. */
export function StatusDot({ tone, className = "" }: { tone: PillTone; className?: string }) {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${DOTS[tone]} ${className}`} />;
}

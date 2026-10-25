import Link from "next/link";
import type { ReactNode } from "react";

// A number with its label and one line of context. Linked when the number
// has somewhere to go.

export function StatTile({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  href?: string;
  // "attention" tints the number when it's something waiting on you.
  tone?: "default" | "attention";
}) {
  const body = (
    <>
      <span className="text-muted block text-[12px]">{label}</span>
      <span
        className={`mt-1 block text-[24px] leading-8 font-semibold tracking-[-0.01em] tabular-nums ${
          tone === "attention" ? "text-accent-text" : "text-ink"
        }`}
      >
        {value}
      </span>
      {hint ? <span className="text-faint mt-0.5 block text-[12px] leading-4">{hint}</span> : null}
    </>
  );
  const cls = "border-line bg-surface block rounded-xl border px-4 py-3";
  return href ? (
    <Link href={href} className={`${cls} hover:border-faint transition-colors duration-150`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

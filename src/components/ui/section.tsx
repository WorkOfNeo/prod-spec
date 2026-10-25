import type { ReactNode } from "react";

// A titled block on a page: 14px heading with an optional count, one line of
// what it is, an action on the right, then the content.

export function Section({
  title,
  count,
  desc,
  action,
  children,
  className = "",
}: {
  title: string;
  count?: number;
  desc?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-ink text-[14px] font-semibold">
            {title}
            {count != null ? <span className="text-faint ml-1.5 font-normal tabular-nums">{count}</span> : null}
          </h2>
          {desc ? <p className="text-muted mt-0.5 text-[12px]">{desc}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

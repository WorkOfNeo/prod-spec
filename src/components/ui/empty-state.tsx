import type { ReactNode } from "react";

// What a list says when it has nothing in it: what that means, and where to go.

export function EmptyState({
  title,
  body,
  children,
  className = "",
}: {
  title: string;
  body?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-line rounded-xl border border-dashed px-6 py-10 text-center ${className}`}>
      <p className="text-ink text-[13px] font-medium">{title}</p>
      {body ? <p className="text-muted mx-auto mt-1 max-w-md text-[13px]">{body}</p> : null}
      {children ? <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}

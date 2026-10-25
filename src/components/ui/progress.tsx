// A short bar for "how much of this is done", with the count beside it.

export function MiniProgress({
  done,
  total,
  label,
  className = "",
}: {
  done: number;
  total: number;
  // What the count means, for screen readers ("decided").
  label: string;
  className?: string;
}) {
  const pct = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden="true" className="bg-subtle h-1.5 w-14 overflow-hidden rounded-full">
        <span className="bg-good block h-full rounded-full" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-muted text-[12px] tabular-nums">
        {done}/{total}
        <span className="sr-only"> {label}</span>
      </span>
    </span>
  );
}

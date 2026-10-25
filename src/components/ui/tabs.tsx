import Link from "next/link";

// Underline tabs that are links (?tab=…), so a page stays a server component
// and every tab has its own URL. The count sits quietly after the label.

export type TabLink = { key: string; label: string; href: string; count?: number };

export function TabLinks({
  items,
  active,
  label,
  className = "",
}: {
  items: TabLink[];
  active: string;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={`border-line flex gap-5 overflow-x-auto border-b ${className}`}>
      {items.map((t) => {
        const on = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            scroll={false}
            aria-current={on ? "page" : undefined}
            className={`-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-[13px] transition-colors duration-150 ${
              on ? "border-ink text-ink font-medium" : "text-muted hover:text-ink border-transparent"
            }`}
          >
            {t.label}
            {t.count != null ? <span className="text-faint text-[12px] font-normal tabular-nums">{t.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

import Link from "next/link";

// The /reviews tab bar: "Review" (the grouped first-review queue) and
// "In Progress" (reviews already started, shared). Server component — just
// Links with a count badge; the active tab is decided by the page from ?tab=.
const TABS = [
  { key: "queue", label: "Review", href: "/reviews" },
  { key: "in-progress", label: "In Progress", href: "/reviews?tab=in-progress" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function ReviewTabs({
  active,
  queueCount,
  inProgressCount,
}: {
  active: TabKey;
  queueCount: number;
  inProgressCount: number;
}) {
  const counts: Record<TabKey, number> = {
    queue: queueCount,
    "in-progress": inProgressCount,
  };
  return (
    <nav className="mt-6 border-b border-zinc-200">
      <ul className="flex gap-1">
        {TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                scroll={false}
                className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition ${
                  isActive
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-700"
                }`}
              >
                {t.label}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                    isActive ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600"
                  }`}
                >
                  {counts[t.key]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

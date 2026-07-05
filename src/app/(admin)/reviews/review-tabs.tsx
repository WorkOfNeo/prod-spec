import Link from "next/link";

// The /reviews tab bar. "In Progress" is the PRIMARY tab — first, the default
// (href "/reviews"), and blue — because it's the live worklist you finish off.
// "Review" is the secondary "pick up next" queue you reach for after that
// (href "/reviews?tab=queue"). Server component — just Links with a count
// badge; the active tab is decided by the page from ?tab=.
const TABS = [
  { key: "in-progress", label: "In Progress", href: "/reviews", accent: "blue" },
  { key: "queue", label: "Review", href: "/reviews?tab=queue", accent: "zinc" },
  { key: "needs-input", label: "Needs input", href: "/reviews?tab=needs-input", accent: "amber" },
  // The done pile — progress you can SEE. Emerald, last: it's the outcome,
  // not a worklist.
  { key: "approved", label: "Approved", href: "/reviews?tab=approved", accent: "emerald" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
type Accent = (typeof TABS)[number]["accent"];

// Filled when active (the blue/dark "bg"), tinted-text when not. The active
// badge sits on the filled tab, so it goes translucent-white.
const ACTIVE: Record<Accent, { tab: string; badge: string }> = {
  blue: { tab: "bg-blue-600 text-white shadow-sm", badge: "bg-white/25 text-white" },
  zinc: { tab: "bg-zinc-900 text-white shadow-sm", badge: "bg-white/25 text-white" },
  amber: { tab: "bg-amber-500 text-white shadow-sm", badge: "bg-white/25 text-white" },
  emerald: { tab: "bg-emerald-600 text-white shadow-sm", badge: "bg-white/25 text-white" },
};
const INACTIVE: Record<Accent, { tab: string; badge: string }> = {
  blue: { tab: "text-blue-700 hover:bg-blue-100", badge: "bg-blue-100 text-blue-700" },
  zinc: { tab: "text-zinc-600 hover:bg-zinc-200", badge: "bg-zinc-200 text-zinc-600" },
  amber: { tab: "text-amber-700 hover:bg-amber-100", badge: "bg-amber-100 text-amber-700" },
  emerald: { tab: "text-emerald-700 hover:bg-emerald-100", badge: "bg-emerald-100 text-emerald-700" },
};

export function ReviewTabs({
  active,
  queueCount,
  inProgressCount,
  needsInputCount,
  approvedCount,
}: {
  active: TabKey;
  queueCount: number;
  inProgressCount: number;
  needsInputCount: number;
  approvedCount: number;
}) {
  const counts: Record<TabKey, number> = {
    queue: queueCount,
    "in-progress": inProgressCount,
    "needs-input": needsInputCount,
    approved: approvedCount,
  };
  return (
    <nav className="mt-6">
      <ul className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
        {TABS.map((t) => {
          const s = (active === t.key ? ACTIVE : INACTIVE)[t.accent];
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                scroll={false}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition ${s.tab}`}
              >
                {t.label}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${s.badge}`}
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

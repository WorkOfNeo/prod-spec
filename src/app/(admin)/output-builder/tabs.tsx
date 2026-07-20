import Link from "next/link";

// Output Builder tab bar. The builder grew a second, non-editing view (file
// name collisions), so the list page needs a switcher — same ?tab= convention
// the Prod Spec editor uses.
export type OutputBuilderTab = "layouts" | "file-names";

const TABS: Array<{ key: OutputBuilderTab; label: string; href: string }> = [
  { key: "layouts", label: "Layouts", href: "/output-builder" },
  { key: "file-names", label: "File names", href: "/output-builder?tab=file-names" },
];

export function OutputBuilderTabs({
  active,
  // Layouts with at least one file-name collision — badged so the problem is
  // visible without opening the tab.
  brokenCount = 0,
}: {
  active: OutputBuilderTab;
  brokenCount?: number;
}) {
  return (
    <div className="mt-5 flex items-center gap-1 border-b border-zinc-200">
      {TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            className={
              isActive
                ? "-mb-px border-b-2 border-zinc-900 px-3 py-2 text-sm font-medium text-zinc-900"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 hover:text-zinc-800"
            }
          >
            {t.label}
            {t.key === "file-names" && brokenCount > 0 ? (
              <span className="ml-2 rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700">
                {brokenCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

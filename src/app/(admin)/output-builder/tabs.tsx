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
    <nav aria-label="Output builder" className="border-line mt-4 flex gap-5 border-b">
      {TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 text-[13px] transition-colors duration-150 ${
              isActive ? "border-ink text-ink font-medium" : "text-muted hover:text-ink border-transparent"
            }`}
          >
            {t.label}
            {t.key === "file-names" && brokenCount > 0 ? (
              <span className="bg-bad-soft text-bad rounded-full px-1.5 text-[11px] font-medium tabular-nums">
                {brokenCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

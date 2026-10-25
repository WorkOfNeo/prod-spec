"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { NavGroup, SettingsLink } from "./nav";
import { Sidebar } from "./sidebar";

/** The section a path belongs to, for the top bar's breadcrumb. */
function sectionOf(pathname: string, groups: NavGroup[], settings: SettingsLink[] | null): string | null {
  const items: Array<{ href: string; label: string; match?: string }> = [
    ...groups.flatMap((g) => g.items),
    ...(settings ?? []),
    { href: "/guides", label: "Guides" },
  ];
  let best: { label: string; len: number } | null = null;
  for (const item of items) {
    const base = item.match ?? item.href;
    if ((pathname === base || pathname.startsWith(`${base}/`)) && (!best || base.length > best.len)) {
      best = { label: item.label, len: base.length };
    }
  }
  return best?.label ?? null;
}

/**
 * The frame around every signed-in page: the sidebar, and a 48px top bar with
 * where you are and the notification bell. Under 860px the sidebar becomes a
 * drawer behind the menu button.
 */
export function AppShell({
  groups,
  settings,
  homeHref,
  user,
  bell,
  children,
}: {
  groups: NavGroup[];
  settings: SettingsLink[] | null;
  homeHref: string;
  user: { name: string; email: string };
  bell: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // The drawer (under 860px); every link in it closes it.
  const [open, setOpen] = useState(false);
  const section = sectionOf(pathname, groups, settings);

  return (
    <div className="flex min-h-screen w-full">
      {/* Beside the content from 860px; a drawer below that. */}
      <div className="sticky top-0 hidden h-screen shrink-0 min-[860px]:block">
        <Sidebar groups={groups} settings={settings} homeHref={homeHref} user={user} />
      </div>
      {open ? (
        <div className="fixed inset-0 z-50 min-[860px]:hidden">
          <button type="button" aria-label="Close the menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-[rgb(15_17_21/0.4)]" />
          <div className="reveal relative h-full w-fit shadow-[var(--shadow-lift)]">
            <Sidebar groups={groups} settings={settings} homeHref={homeHref} user={user} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-line bg-bg sticky top-0 z-30 flex h-12 shrink-0 items-center gap-1 border-b px-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open the menu"
            className="text-muted hover:bg-subtle hover:text-ink inline-flex size-8 items-center justify-center rounded-md min-[860px]:hidden"
          >
            <Menu size={16} aria-hidden="true" />
          </button>
          <nav aria-label="Where you are" className="flex min-w-0 items-center gap-1 text-[14px]">
            <span className="flex h-8 items-center gap-2 px-2 font-medium">
              <span
                aria-hidden="true"
                className="bg-primary text-primary-ink flex size-5 items-center justify-center rounded-[5px] text-[11px] font-semibold"
              >
                C
              </span>
              Contrast
            </span>
            {section ? (
              <>
                <span aria-hidden="true" className="text-faint px-0.5 text-[15px]">
                  /
                </span>
                <span className="text-muted truncate px-1">{section}</span>
              </>
            ) : null}
          </nav>
          <div className="flex-1" />
          {bell}
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

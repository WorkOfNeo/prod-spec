"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  Barcode,
  BookOpen,
  Building2,
  ChevronRight,
  ClipboardPen,
  Database,
  Factory,
  FileImage,
  FileText,
  FolderCheck,
  Inbox,
  Layers,
  LayoutTemplate,
  ListChecks,
  MessageSquare,
  Settings,
  Shield,
  Shirt,
  Truck,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useVisiblePoll } from "@/lib/use-visible-poll";
import { isActive, type NavGroup, type NavIcon, type NavItem, type SettingsLink } from "./nav";
import { UserMenu } from "./user-menu";

const ICONS: Record<NavIcon, LucideIcon> = {
  tasks: ListChecks,
  reviews: Inbox,
  rejections: MessageSquare,
  styles: Shirt,
  delivery: Truck,
  checks: FolderCheck,
  requests: ClipboardPen,
  combos: Layers,
  jobs: Activity,
  automation: Workflow,
  admin: Shield,
  devData: Database,
  prodSpecs: FileText,
  outputBuilder: LayoutTemplate,
  poBarcodes: Barcode,
  customers: Building2,
  suppliers: Factory,
  users: Users,
  coverPage: FileImage,
  guides: BookOpen,
};

const itemClass = (active: boolean) =>
  `flex h-8 items-center gap-2.5 rounded-md px-2 transition-colors duration-150 ${
    active ? "bg-active text-active-ink font-medium" : "text-muted hover:bg-subtle hover:text-ink"
  }`;

/** The sidebar's own logo: a spec sheet in a rounded square. */
function LogoMark() {
  return (
    <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden="true">
      <rect width="20" height="20" rx="5" className="fill-primary" />
      <path d="M6.5 6.5h7M6.5 10h7M6.5 13.5h4" className="stroke-primary-ink" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The "waiting on you" count for My tasks. Polls /api/admin/dashboard/counts
 * every 60s while the tab is visible. It counts only reviews you've started and
 * haven't finished; the untouched first-review queue lives on Reviews.
 */
function TasksCount() {
  const [counts, setCounts] = useState<{ badge: number; parts: { mine: number } } | null>(null);
  useVisiblePoll(async (signal) => {
    try {
      const res = await fetch("/api/admin/dashboard/counts", { cache: "no-store", signal });
      if (res.ok) setCounts(await res.json());
    } catch {
      // Silent — the count keeps its last-known value.
    }
  }, 60_000);
  const badge = counts?.badge ?? 0;
  if (!badge) return null;
  return (
    <span
      className="bg-warn-soft text-warn rounded-full px-1.5 text-[11px] font-semibold leading-[18px] tabular-nums"
      title={`${counts!.parts.mine} review${counts!.parts.mine === 1 ? "" : "s"} you've started and haven't finished`}
    >
      {badge > 99 ? "99+" : badge}
    </span>
  );
}

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const Icon = ICONS[item.icon];
  const active = isActive(pathname, item.href, item.match);
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} onClick={onNavigate} className={itemClass(active)}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge === "tasks" ? <TasksCount /> : null}
    </Link>
  );
}

/** Configuration and reference data, folded away until opened (or until you're on one of them). */
function SettingsGroup({ links, pathname, onNavigate }: { links: SettingsLink[]; pathname: string; onNavigate?: () => void }) {
  const anyActive = links.some((l) => isActive(pathname, l.href));
  const [open, setOpen] = useState(anyActive);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`${itemClass(false)} w-full ${anyActive ? "text-ink font-medium" : ""}`}
      >
        <Settings size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="flex-1 text-left">Settings</span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div className="border-line ml-[17px] mt-0.5 flex flex-col gap-px border-l pl-2">
          {links.map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={`flex h-7 items-center rounded-md px-2 text-[13px] transition-colors duration-150 ${
                  active ? "bg-active text-active-ink font-medium" : "text-muted hover:bg-subtle hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** The navigation: 212px on a quiet grey, groups of 32px links, Guides and Settings at the foot, then who's signed in. */
export function Sidebar({
  groups,
  settings,
  homeHref,
  user,
  onNavigate,
}: {
  groups: NavGroup[];
  settings: SettingsLink[] | null;
  homeHref: string;
  user: { name: string; email: string };
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <aside
      data-section="Sidebar"
      aria-label="Main"
      className="border-line bg-sidebar flex h-full w-[212px] flex-col overflow-y-auto border-r px-2 pb-2"
    >
      <Link href={homeHref} onClick={onNavigate} className="flex h-12 shrink-0 items-center gap-2 px-2 text-[15px] font-semibold tracking-[-0.01em]">
        <LogoMark />
        Prod Spec
      </Link>
      {/* Named too: analyticsOS labels a click by its CLOSEST section. */}
      <nav data-section="Sidebar" className="flex flex-col">
        {groups.map((group, i) => (
          <div key={group.label ?? i} className="flex flex-col gap-px">
            {group.label ? <span className="text-faint px-2 pb-1 pt-4 text-[12px] font-medium leading-4">{group.label}</span> : null}
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-px pt-4">
        <NavLink item={{ href: "/guides", label: "Guides", icon: "guides" }} pathname={pathname} onNavigate={onNavigate} />
        {settings ? <SettingsGroup links={settings} pathname={pathname} onNavigate={onNavigate} /> : null}
      </div>
      <div className="border-line mt-2 border-t pt-2">
        <UserMenu name={user.name} email={user.email} />
      </div>
    </aside>
  );
}

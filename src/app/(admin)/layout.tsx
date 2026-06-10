import Link from "next/link";
import { requireSession } from "@/lib/auth-server";
import { SignOutButton } from "@/components/sign-out-button";
import { NotificationBell } from "@/components/sidebar/notification-bell";
import { SettingsNav } from "@/components/sidebar/settings-nav";

// Primary, high-traffic destinations only. Config / admin surfaces
// (Monday, catalogues, reference data) live under the Settings dropdown
// rendered after this list — see SettingsNav.
const NAV: Array<{ href?: string; label?: string; divider?: true }> = [
  { href: "/styles", label: "Styles" },
  { href: "/jobs", label: "Jobs" },
  { divider: true },
  { href: "/prod-specs", label: "Prod specs" },
  { href: "/custom-outputs", label: "Custom outputs" },
  { href: "/output-builder", label: "Output builder" },
  { href: "/po-eans", label: "PO barcodes" },
  { href: "/customers", label: "Customers" },
  { href: "/suppliers", label: "Suppliers" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen bg-zinc-50">
      <aside className="w-56 border-r border-zinc-200 bg-white px-4 py-6">
        <div className="flex items-center justify-between px-2">
          <Link href="/styles" className="text-lg font-semibold tracking-tight">
            Prod Spec
          </Link>
          <NotificationBell />
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item, i) =>
            item.divider ? (
              <div key={`div-${i}`} className="my-2 border-t border-zinc-100" />
            ) : (
              <Link
                key={item.href}
                href={item.href!}
                className="rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {item.label}
              </Link>
            ),
          )}
          <div className="my-2 border-t border-zinc-100" />
          <SettingsNav />
        </nav>
        <div className="mt-auto absolute bottom-6 left-4 right-4 w-48">
          <div className="border-t border-zinc-200 pt-4 text-xs text-zinc-500">
            <div className="truncate">{session.user.email}</div>
            <SignOutButton />
          </div>
        </div>
      </aside>
      <main className="flex-1">{children}</main>
    </div>
  );
}

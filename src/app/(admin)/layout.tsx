import Link from "next/link";
import { requireSession } from "@/lib/auth-server";
import { SignOutButton } from "@/components/sign-out-button";

const NAV = [
  { href: "/styles", label: "Styles" },
  { href: "/jobs", label: "Jobs" },
  { href: "/settings", label: "Settings" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen bg-zinc-50">
      <aside className="w-56 border-r border-zinc-200 bg-white px-4 py-6">
        <Link href="/styles" className="block px-2 text-lg font-semibold tracking-tight">
          Prod Spec
        </Link>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              {item.label}
            </Link>
          ))}
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

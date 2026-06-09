"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

// The "Settings" group in the sidebar — an expandable dropdown holding the
// admin/config destinations. Grouping these here declutters the top-level
// nav (Styles / Jobs / Prod specs / Customers / Suppliers stay primary).
const SETTINGS_ITEMS: Array<{ href: string; label: string }> = [
  { href: "/settings", label: "General" },
  { href: "/monday", label: "Monday" },
  { href: "/settings/care-labels", label: "Care labels" },
  { href: "/settings/washcare-symbols", label: "Wash care symbols" },
  { href: "/settings/certificates", label: "Certificates" },
  { href: "/settings/qr-codes", label: "QR codes" },
  { href: "/translations", label: "Translations" },
  { href: "/countries", label: "Countries" },
  { href: "/languages", label: "Languages" },
  { href: "/business-areas", label: "Business areas" },
];

function isActive(pathname: string, href: string): boolean {
  // "/settings" is the General landing — exact-match only, otherwise it
  // would light up for every /settings/* sub-page (which have their own
  // entries here).
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SettingsNav() {
  const pathname = usePathname();
  const anyActive = SETTINGS_ITEMS.some((i) => isActive(pathname, i.href));
  // Seed expansion from the active route on first mount; the layout
  // persists across client navigations, so the user's manual toggle then
  // sticks as they move around.
  const [open, setOpen] = useState(anyActive);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-zinc-100 ${
          anyActive ? "font-medium text-zinc-900" : "text-zinc-700"
        }`}
      >
        <span>Settings</span>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="mt-1 ml-3 flex flex-col gap-0.5 border-l border-zinc-200 pl-2">
          {SETTINGS_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  active
                    ? "bg-zinc-100 font-medium text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

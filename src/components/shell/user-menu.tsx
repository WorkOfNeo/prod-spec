"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { Popover } from "@/components/ui/popover";
import { authClient } from "@/lib/auth-client";
import { resetUser } from "@/lib/analytics";
import { ThemeSwitcher } from "./theme-switcher";

function initials(name: string) {
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Who is signed in, at the foot of the sidebar: it opens the theme and Sign out. */
export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  return (
    <Popover
      anchor="--user-menu"
      className="hover:bg-subtle flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-150"
      trigger={
        <>
          <span
            aria-hidden="true"
            className="bg-primary text-primary-ink flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          >
            {initials(name)}
          </span>
          <span data-private className="min-w-0 flex-1 truncate font-medium">
            <span className="sr-only">Account and theme. Signed in as </span>
            {name}
          </span>
          <ChevronsUpDown size={14} aria-hidden="true" className="text-faint shrink-0" />
        </>
      }
    >
      <div className="flex w-[244px] flex-col gap-1">
        <div data-private className="flex flex-col px-2 pb-1.5 pt-1">
          <span className="truncate font-medium">{name}</span>
          <span className="text-muted truncate text-[12px]">{email}</span>
        </div>
        <div className="border-line -mx-1 border-t" />
        <span className="text-faint px-2 pt-1.5 text-[12px] font-medium">Theme</span>
        <div className="px-1 pb-1">
          <ThemeSwitcher />
        </div>
        <div className="border-line -mx-1 border-t" />
        <button
          type="button"
          onClick={async () => {
            await authClient.signOut();
            // Forget the analyticsOS user so the next person on this browser
            // starts as a new visitor (see AnalyticsIdentify).
            resetUser();
            router.push("/login");
            router.refresh();
          }}
          className="text-ink hover:bg-subtle flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150"
        >
          <LogOut size={15} aria-hidden="true" className="text-muted" />
          Sign out
        </button>
      </div>
    </Popover>
  );
}
